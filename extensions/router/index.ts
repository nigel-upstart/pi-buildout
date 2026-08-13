import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ClassificationResult } from "./classifier.ts";
import { compilePrompt } from "./core/compiler.ts";
import { isCodeBuilder } from "./core/features.ts";
import { resolveFallback } from "./core/fallback.ts";
import type { FailureKind } from "./core/fallback.ts";
import {
  changeEffortWithinLease,
  createTaskLease,
  deterministicBoundaryGate,
  installLease,
  markManualOverride,
  resolveContinuity,
  setHardBoundary,
} from "./core/lease.ts";
import type { BoundaryGateResult, LeaseState, RouterMode, TaskLease } from "./core/lease.ts";
import { ProgramPlanSchema, validateProgramPlan } from "./core/planning.ts";
import {
  ActionPlanSchema,
  SafetyReviewSchema,
  deriveSafetyPolicy,
  initialLifecycle,
  isPotentiallyMutatingTool,
  lifecycleRequiresCompletionReview,
  lifecycleToolBlockReason,
  safetyContextForLifecycle,
  safetyFingerprint,
  validateActionPlan,
  validateSafetyReview,
} from "./core/safety.ts";
import type { CompletionEvidence, LeaseLifecycle, ReviewOutcome, SafetyReviewKind } from "./core/safety.ts";
import { POLICY_VERSION } from "./core/policy.ts";
import { findPromptProfile, PROMPT_PROFILES } from "./core/profiles.ts";
import { providerWeightFor } from "./core/provider-weights.ts";
import type { EffortLevel } from "./core/profiles.ts";
import {
  bedrockSolLongContextPricingUnavailable,
  deriveRoutingContext,
  isStandaloneReviewRequest,
  registrySnapshotId,
  selectOrdinaryRoute,
  selectReviewRoute,
  selectStandaloneReviewRoute,
} from "./core/routing.ts";
import { canonicalModelId } from "./core/scope.ts";
import { buildScopeDiagnostics, renderScopeDiagnostics } from "./core/scope-diagnostics.ts";
import { parseRouterMode, UNKNOWN_LAST_MODE } from "./core/start-mode.ts";
import type { RegistryModelSnapshot, RouteChoice, RouteDecision, RouteSample } from "./core/routing.ts";
import { buildSessionSynopsis } from "./core/synopsis.ts";
import type { RepositoryMetadata, SessionSynopsis } from "./core/synopsis.ts";
import { classifyTaskWithPi } from "./pi-classifier.ts";
import {
  buildRegistrySnapshot,
  EMPTY_SCOPE,
  hasPersistedRouterState,
  readRouterScope,
  readStartModeResolution,
  resolveRouterRepoKey,
  cacheEstimate,
  latestReportedContextTokens,
  modelAbility,
  normalizeSessionEntries,
  promptFingerprint,
  readRepositoryMetadata,
  restoreLeaseState,
  routeRequirements,
  snapshotForModel,
  writeLastKnownMode,
} from "./pi-state.ts";
import type { RouterScope } from "./pi-state.ts";
import {
  aggregateAttemptTokenCounts,
  aggregateRouteSamples,
  annotateClassifierSpan,
  annotateRouterSpan,
  attemptOutcomesFromTelemetry,
  completeClassifierInvocation,
  endpointTelemetryFields,
  JsonlTelemetryStore,
  runClassifierInvocation,
  sanitizeClassifierAttempt,
  sanitizeClassifierFeatures,
  withRouterSpan,
} from "./telemetry.ts";
import type { ClassifierInvocationPurpose, ClassifierInvocationSummary, RouterTelemetryEvent } from "./telemetry.ts";

const STATE_ENTRY = "model-router-state";
const CONTEXT_MESSAGE = "model-router-context";

type PendingInput = {
  gate: BoundaryGateResult;
  repository: Promise<RepositoryMetadata>;
  cache: { cachedTokens: number; expectedReuseRatio: number };
  hasImages: boolean;
  source: "interactive" | "rpc" | "extension";
};

type LastRoute = {
  classification?: ClassificationResult;
  decision?: RouteDecision;
  boundaryReason?: string;
};

type AttemptMetrics = {
  provider: string;
  modelId: string;
  archetype: TaskLease["archetype"];
  modelAndToolCost: number;
  wallTimeMs: number;
  retried: boolean;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

type AttemptDisposition = "unknown" | "pending" | "success" | "aborted" | "incomplete" | "failed";

export function automaticRoutingBlockReason(
  classification: Pick<ClassificationResult, "failedClosed">,
): string | undefined {
  return classification.failedClosed
    ? "classification failed closed; premium routes require validated semantic evidence"
    : undefined;
}

export function deterministicCheckCommand(command: string): string | undefined {
  const normalized = command.trim();
  if (!/\b(?:test|check|lint|typecheck|audit|scan)\b/i.test(normalized)) return undefined;
  // Do not treat shell constructs that can mask an earlier non-zero exit as verification evidence.
  if (/\|\||[;|\n\r]|(^|[^&])&([^&]|$)|(^|\s)!(?=\s)/.test(normalized)) return undefined;
  return normalized.slice(0, 500);
}

const SAFETY_LIFECYCLE_TOOL_NAMES = new Set(["submit_action_plan", "submit_safety_review"]);

/** Keep lifecycle validators out of the model's tool surface unless the active phase can accept them. */
export function activeToolsForSafetyLifecycle(
  activeTools: readonly string[],
  lifecycle: LeaseLifecycle | undefined,
): string[] {
  const next = activeTools.filter((name) => !SAFETY_LIFECYCLE_TOOL_NAMES.has(name));
  if (lifecycle?.phase === "preflight") next.push("submit_action_plan");
  if (lifecycle?.phase === "review") next.push("submit_safety_review");
  return next;
}

function sameRouteChoice(left: RouteChoice, right: RouteChoice): boolean {
  return (
    left.provider === right.provider &&
    left.modelId === right.modelId &&
    left.effort === right.effort &&
    left.profileId === right.profileId
  );
}

/** Carry an explicit model/effort choice across a semantic task boundary without carrying the old lease. */
export function routeChoicesForNewLease(
  routedSelection: RouteChoice,
  routedFallbacks: readonly RouteChoice[],
  previousSelection: RouteChoice | undefined,
  preservePreviousSelection: boolean,
): { selected: RouteChoice; previousSelection?: RouteChoice; fallbacks: RouteChoice[] } {
  const selected = preservePreviousSelection && previousSelection ? previousSelection : routedSelection;
  const fallbackCandidates =
    preservePreviousSelection && previousSelection ? [routedSelection, ...routedFallbacks] : [...routedFallbacks];
  const fallbacks: RouteChoice[] = [];
  for (const candidate of fallbackCandidates) {
    if (sameRouteChoice(candidate, selected) || fallbacks.some((existing) => sameRouteChoice(existing, candidate))) {
      continue;
    }
    fallbacks.push(candidate);
  }
  return {
    selected,
    ...(previousSelection ? { previousSelection } : {}),
    fallbacks,
  };
}

export function safetyToolBlockReason(
  lease: Pick<TaskLease, "lifecycle" | "manualOverride"> | undefined,
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (lease?.manualOverride && (lease.lifecycle.policy !== "ordinary" || lease.lifecycle.phase === "review")) {
    return "Manual model/effort override invalidated the active safety lifecycle; re-enable active routing or start a new task";
  }
  return lifecycleToolBlockReason(lease?.lifecycle, toolName, input);
}

// A hung classifier/selection call must never block the agent turn indefinitely. Eleven seconds
// accommodates observed classifier latency while keeping the deadline bounded; past that we abort
// the in-flight request (via the shared AbortSignal, so the underlying network call is actually
// cancelled rather than merely abandoned) and the caller keeps whatever model/task is already
// selected instead of routing on a call that never returned.
export const CLASSIFICATION_TIMEOUT_MS = 11_000;
async function classifyWithTimeout(
  ctx: ExtensionContext,
  registry: readonly RegistryModelSnapshot[],
  prompt: string,
  taskSynopsis: SessionSynopsis,
  purpose: ClassifierInvocationPurpose,
  classify: typeof classifyTaskWithPi,
) {
  return runClassifierInvocation<ClassificationResult>({
    purpose,
    timeoutMs: CLASSIFICATION_TIMEOUT_MS,
    invoke: (signal, onAttempt) =>
      classify({
        ctx,
        registry,
        prompt,
        synopsis: taskSynopsis,
        signal,
        onAttempt,
      }),
  });
}

/**
 * The mode held before any configuration is read. Routing stays observational unless the environment
 * explicitly enables it, so a malformed or absent environment value cannot activate routing before
 * `session_start` resolves the operator's configured start mode.
 */
function provisionalMode(): RouterMode {
  return parseRouterMode(process.env.PI_ROUTER_MODE) ?? UNKNOWN_LAST_MODE;
}

function assistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === "assistant";
}

function currentTokens(ctx: ExtensionContext): number {
  return Math.max(ctx.getContextUsage()?.tokens ?? 0, latestReportedContextTokens(ctx.sessionManager.getBranch()));
}

function contextSizeBucket(ctx: ExtensionContext, features: TaskLease["features"]): string {
  const tokens = routeRequirements(currentTokens(ctx), features, false).estimatedFinishedTokens;
  const numeric =
    tokens < 32_000 ? "lt32k" : tokens < 128_000 ? "32k-128k" : tokens < 512_000 ? "128k-512k" : "gte512k";
  return `${features.contextShape}:${numeric}`;
}

function statusLabel(state: LeaseState): string {
  const lease = state.active;
  if (!lease) return `route:${state.mode}`;
  return `route:${state.mode}${lease.executionFailed ? ":failed" : ""}:${lease.lifecycle.phase} ${lease.selected.vendor}/${lease.selected.modelId} ${lease.selected.effort}`;
}

export function resumeCompletedLifecycle(
  completed: Extract<LeaseLifecycle, { phase: "completed" }>,
  sessionId: string,
): LeaseLifecycle {
  if (completed.policy === "completion_review") {
    return { phase: "building", policy: completed.policy, taskFingerprint: completed.taskFingerprint };
  }
  if (completed.policy === "advisory_then_completion_review" && completed.advisory) {
    return {
      phase: "ready_after_advisory",
      policy: completed.policy,
      taskFingerprint: completed.taskFingerprint,
      advisory: completed.advisory,
    };
  }
  if (completed.policy === "authorization_then_completion_review" && completed.plan && completed.authorization) {
    // An approval is scoped to the session that obtained it, exactly as the restore-time check in
    // session_start enforces. Resuming completed work elsewhere must re-earn authorization.
    return completed.authorization.sessionId === sessionId
      ? {
          phase: "authorized_execution",
          policy: completed.policy,
          taskFingerprint: completed.taskFingerprint,
          plan: completed.plan,
          authorization: completed.authorization,
        }
      : {
          phase: "preflight",
          policy: completed.policy,
          taskFingerprint: completed.taskFingerprint,
          plan: completed.plan,
        };
  }
  return { phase: "ordinary", policy: "ordinary", taskFingerprint: completed.taskFingerprint };
}

function previousChoice(
  model: RegistryModelSnapshot | undefined,
  effort: EffortLevel,
  archetype: TaskLease["archetype"],
): RouteChoice | undefined {
  if (!model) return undefined;
  const profile = findPromptProfile(model.vendor, model.modelId, archetype, effort);
  if (!profile) return undefined;
  return {
    provider: model.provider,
    modelId: model.modelId,
    // Registry IDs are provider-specific spellings; the logical ID is always canonical, and
    // isRouteChoice enforces that pairing when a lease is rehydrated.
    logicalModelId: canonicalModelId(model.modelId),
    vendor: model.vendor,
    effort,
    ability: modelAbility(model.modelId, effort),
    profileId: profile.id,
    contextWindow: model.contextWindow,
    endpointTier: "manufacturer",
    rankReason: "bootstrap",
  };
}

type RouterExtensionOptions = {
  telemetry?: Pick<JsonlTelemetryStore, "append" | "read">;
  /** Test seam for deterministic adapter failure and telemetry-contract regressions. */
  classifyTask?: typeof classifyTaskWithPi;
};

export default function routerExtension(pi: ExtensionAPI, options: RouterExtensionOptions = {}): void {
  /**
   * The operator's model scope and last probe results, read once per session. Routing derives its
   * candidate endpoints from this rather than from a table in the repository, so enabling or disabling
   * a model in settings changes what the router can pick without a code change.
   */
  let scope: RouterScope = EMPTY_SCOPE;
  const telemetry =
    options.telemetry ??
    new JsonlTelemetryStore(
      process.env.PI_ROUTER_TELEMETRY_PATH ?? join(getAgentDir(), "router-telemetry", "events.jsonl"),
    );
  const classifyTask = options.classifyTask ?? classifyTaskWithPi;
  let state: LeaseState = { mode: provisionalMode(), manualOverride: false };
  // The replacement session has a new branch, so carry only the enablement mode
  // across /clear. The task lease must still be discarded at the new-session
  // boundary.
  let modeForNextSession: RouterMode | undefined;
  // Repository identity for repository-scoped start-mode configuration and for the recorded exit
  // mode. Resolved once per working directory because it costs git calls and cannot change while a
  // session runs, but /resume can move the process to a different checkout.
  let repoKey: string | undefined;
  let repoKeyCwd: string | undefined;
  let recordedExitMode: RouterMode | undefined;
  let pendingInput: PendingInput | undefined;
  let nextParentTaskId: string | undefined;
  let lastRoute: LastRoute = {};
  let lastUpstream: string | undefined;
  let applyingSelection = false;
  let lastProviderFailure: FailureKind | undefined;
  let attemptStartedAt = 0;
  let attemptTurns = 0;
  let attemptToolCalls = 0;
  let agentRunSequence = 0;
  const deterministicCheckCalls = new Map<string, string>();
  const deterministicCheckResults = new Map<string, boolean>();
  const potentiallyMutatingCalls = new Map<string, { toolName: string; inputFingerprint: string }>();
  const validatedPlanAttempts = new Set<string>();
  let lastAttemptMetrics: AttemptMetrics | undefined;
  let reviewParentAttemptMetrics: AttemptMetrics | undefined;
  const accumulatedTaskCosts = new Map<string, number>();
  const taskStartedAt = new Map<string, number>();
  let telemetryHealthy = true;
  let attemptDisposition: AttemptDisposition = "unknown";

  function syncSafetyLifecycleTools(lifecycle: LeaseLifecycle | undefined): void {
    const current = pi.getActiveTools();
    const next = activeToolsForSafetyLifecycle(current, lifecycle);
    if (current.length !== next.length || current.some((name, index) => name !== next[index])) {
      pi.setActiveTools(next);
    }
  }

  function invalidateAuthorization(lease: TaskLease, reason: string): TaskLease {
    const authorizationLifecycle =
      lease.lifecycle.phase === "authorized_execution"
        ? lease.lifecycle
        : lease.lifecycle.phase === "completed" &&
            lease.lifecycle.policy === "authorization_then_completion_review" &&
            lease.lifecycle.plan
          ? lease.lifecycle
          : undefined;
    if (!authorizationLifecycle?.plan) return lease;
    const now = new Date().toISOString();
    return {
      ...lease,
      updatedAt: now,
      lifecycle: {
        phase: "preflight",
        policy: "authorization_then_completion_review",
        taskFingerprint: authorizationLifecycle.taskFingerprint,
        plan: authorizationLifecycle.plan,
        lastAuthorizationReview: {
          kind: "authorization",
          summary: `Authorization invalidated at ${reason}; the exact plan requires a fresh independent review.`,
          completedAt: now,
        },
      },
    };
  }

  function persistState(): void {
    pi.appendEntry(STATE_ENTRY, {
      mode: state.mode,
      manualOverride: state.manualOverride,
      active: state.active,
    });
  }

  /**
   * Records the mode now in force so `startMode: "last"` can restore it in the next session, whether
   * that session comes from `/clear`, `/compact`, or the next `pi` launch. Recording is best-effort:
   * an unwritable state directory must not fail a turn, it only means the next start falls back to the
   * configured or built-in default.
   */
  async function rememberMode(mode: RouterMode): Promise<void> {
    if (mode === recordedExitMode) return;
    try {
      await writeLastKnownMode(getAgentDir(), repoKey, mode);
      recordedExitMode = mode;
    } catch {
      // Ignored deliberately; see above.
    }
  }

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus("model-router", ctx.ui.theme.fg(state.mode === "active" ? "accent" : "muted", statusLabel(state)));
  }

  function disableForTelemetryFailure(ctx: ExtensionContext, error: unknown): void {
    if (!telemetryHealthy) return;
    telemetryHealthy = false;
    if (state.mode === "active") {
      state = { ...state, mode: "shadow" };
      persistState();
      updateStatus(ctx);
      void rememberMode(state.mode);
    }
    ctx.ui.notify(
      `Router telemetry failed; automatic routing is disabled for this session: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }

  async function record(
    ctx: ExtensionContext,
    kind: RouterTelemetryEvent["kind"],
    data: Record<string, unknown>,
    extra: Partial<
      Omit<RouterTelemetryEvent, "version" | "eventId" | "timestamp" | "kind" | "sessionId" | "data">
    > = {},
  ): Promise<void> {
    if (!telemetryHealthy) return;
    try {
      let endpointFields = {};
      if (extra.provider && extra.modelId) {
        try {
          const model = ctx.modelRegistry.find(extra.provider, extra.modelId);
          if (model) {
            endpointFields = endpointTelemetryFields(
              { provider: model.provider, costPerMillion: model.cost },
              providerWeightFor(model.provider, scope.providerWeights),
            );
          }
        } catch {
          // Endpoint diagnostics are best-effort and must never block the base audit event.
        }
      }
      await telemetry.append({
        version: 1,
        eventId: randomUUID(),
        timestamp: new Date().toISOString(),
        kind,
        sessionId: ctx.sessionManager.getSessionId(),
        ...endpointFields,
        ...extra,
        data,
      });
    } catch (error) {
      disableForTelemetryFailure(ctx, error);
    }
  }

  async function recordClassifierInvocation(
    ctx: ExtensionContext,
    summary: ClassifierInvocationSummary,
    classification?: ClassificationResult,
    taskId?: string,
  ): Promise<void> {
    await record(
      ctx,
      "classifier_invocation",
      {
        ...summary,
        // This count is a router-level request metric. Per-attempt diagnostics are intentionally
        // non-additive and remain under the legacy classifier_attempt event kind.
        invocationCount: 1,
      },
      {
        ...(taskId ? { taskId } : {}),
        ...(classification ? { archetype: classification.archetype.archetype } : {}),
      },
    );
  }

  async function classifyContinuityWithTelemetry(
    ctx: ExtensionContext,
    registry: readonly RegistryModelSnapshot[],
    prompt: string,
    taskSynopsis: SessionSynopsis,
    lease: TaskLease,
    cache: { cachedTokens: number; expectedReuseRatio: number },
  ) {
    return withRouterSpan(
      ctx.sessionManager.getSessionId(),
      "router.classify_continuity",
      { "router.mode": state.mode },
      async (span) => {
        const invocation = await classifyWithTimeout(ctx, registry, prompt, taskSynopsis, "continuity", classifyTask);
        let continuity: ReturnType<typeof resolveContinuity> | undefined;
        let summary = invocation.summary;
        if (invocation.status === "completed") {
          continuity = resolveContinuity(lease, invocation.value.features, cache);
          summary = completeClassifierInvocation(
            summary,
            continuity.action === "new_task" ? "new_task" : "retained_continuity",
            invocation.value.failedClosed,
          );
        } else {
          // Timeout, cancellation, and unexpected failure all apply the same continuity policy:
          // retain the active lease. Finalize that effective policy before emitting any summary.
          summary = { ...summary, resolution: "retained_continuity" };
        }
        invocation.summary = summary;
        annotateClassifierSpan(span, summary);
        await recordClassifierInvocation(
          ctx,
          summary,
          invocation.status === "completed" ? invocation.value : undefined,
          lease.taskId,
        );
        return { invocation, continuity };
      },
    );
  }

  async function classifyFreshTaskWithTelemetry(
    ctx: ExtensionContext,
    registry: readonly RegistryModelSnapshot[],
    prompt: string,
    taskSynopsis: SessionSynopsis,
  ) {
    return withRouterSpan(
      ctx.sessionManager.getSessionId(),
      "router.classify",
      { "router.mode": state.mode },
      async (span) => {
        const invocation = await classifyWithTimeout(ctx, registry, prompt, taskSynopsis, "fresh_task", classifyTask);
        const summary =
          invocation.status === "completed"
            ? completeClassifierInvocation(invocation.summary, "classified", invocation.value.failedClosed)
            : invocation.summary;
        invocation.summary = summary;
        annotateClassifierSpan(span, summary);
        await recordClassifierInvocation(
          ctx,
          summary,
          invocation.status === "completed" ? invocation.value : undefined,
        );
        return invocation;
      },
    );
  }

  async function classifyTurn(
    ctx: ExtensionContext,
    registry: readonly RegistryModelSnapshot[],
    prompt: string,
    taskSynopsis: SessionSynopsis,
    pending: PendingInput | undefined,
    initialActive: TaskLease | undefined,
  ): Promise<{
    active?: TaskLease;
    classification?: ClassificationResult;
    requiresNewLease: boolean;
    boundaryReason?: string;
  }> {
    let active = initialActive;
    let classification: ClassificationResult | undefined;
    let requiresNewLease = pending?.gate.action === "new_task";
    let boundaryReason: string | undefined;
    const continuityGate = pending?.gate;

    if (pending && continuityGate?.action === "classify_continuity") {
      const result = await classifyContinuityWithTelemetry(
        ctx,
        registry,
        prompt,
        taskSynopsis,
        continuityGate.lease,
        pending.cache,
      );
      if (result.invocation.status === "completed" && result.continuity) {
        classification = result.invocation.value;
        requiresNewLease = result.continuity.action === "new_task";
        boundaryReason = result.continuity.reason;
        if (!requiresNewLease) active = continuityGate.lease;
      } else {
        const summary = result.invocation.summary;
        const reason = summary.timedOut ? "timed out" : summary.cancelled ? "was cancelled" : "failed";
        ctx.ui.notify(
          summary.timedOut
            ? `Router continuity classification timed out after ${String(CLASSIFICATION_TIMEOUT_MS / 1000)}s; keeping the current task and model selection`
            : `Router continuity classification ${reason}; keeping the current task and model selection`,
          "warning",
        );
        requiresNewLease = false;
        active = continuityGate.lease;
        boundaryReason = `classification ${reason}; retained current lease`;
      }
    }

    if (requiresNewLease && !classification) {
      const result = await classifyFreshTaskWithTelemetry(ctx, registry, prompt, taskSynopsis);
      if (result.status === "completed") {
        classification = result.value;
      } else {
        const reason = result.summary.timedOut ? "timed out" : result.summary.cancelled ? "was cancelled" : "failed";
        ctx.ui.notify(
          result.summary.timedOut
            ? `Router classification timed out after ${String(CLASSIFICATION_TIMEOUT_MS / 1000)}s; keeping the current model selection`
            : `Router classification ${reason}; keeping the current model selection`,
          "warning",
        );
      }
    }

    return {
      ...(active ? { active } : {}),
      ...(classification ? { classification } : {}),
      requiresNewLease,
      ...(boundaryReason ? { boundaryReason } : {}),
    };
  }

  function synopsis(
    ctx: ExtensionContext,
    repository: RepositoryMetadata,
    omitBuilderProvenance = false,
    scopedRegistry?: readonly RegistryModelSnapshot[],
  ): SessionSynopsis {
    const usage = ctx.getContextUsage();
    // The registry, not the endpoint name, identifies gateway-backed models' canonical vendor.
    // Callers that already hold the turn's scoped snapshot pass it in rather than rebuilding it.
    const vendor = ctx.model
      ? snapshotForModel(ctx.model, scopedRegistry ?? buildRegistrySnapshot(ctx, scope))?.vendor
      : undefined;
    return buildSessionSynopsis({
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
      ...(!omitBuilderProvenance && ctx.model
        ? {
            builder: {
              provider: ctx.model.provider,
              modelId: ctx.model.id,
              ...(vendor ? { vendor } : {}),
              effort: pi.getThinkingLevel(),
            },
          }
        : {}),
      activeTools: pi.getActiveTools(),
      contextTokens: usage?.tokens ?? 0,
      contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? 1,
      entries: normalizeSessionEntries(ctx.sessionManager.getBranch()),
      repository,
    });
  }

  async function route(
    ctx: ExtensionContext,
    registry: readonly RegistryModelSnapshot[],
    classification: ClassificationResult,
    hasImages: boolean,
    languageBucket: string,
    languageBuckets: readonly string[],
    contextBucket: string,
    explorationKey: string,
  ): Promise<{ decision: RouteDecision; registry: readonly RegistryModelSnapshot[] }> {
    const blockReason = automaticRoutingBlockReason(classification);
    if (blockReason) {
      return {
        registry,
        decision: {
          kind: "unroutable",
          policyVersion: POLICY_VERSION,
          archetype: classification.archetype.archetype,
          reason: blockReason,
          exclusions: [],
        },
      };
    }
    const requirements = routeRequirements(currentTokens(ctx), classification.features, hasImages);
    let events: RouterTelemetryEvent[] = [];
    try {
      events = await telemetry.read();
    } catch (error) {
      // Bootstrap ordering is safe without history; disable active routing rather than use stale telemetry.
      disableForTelemetryFailure(ctx, error);
    }
    const routeSamples: RouteSample[] = aggregateRouteSamples(attemptOutcomesFromTelemetry(events)).filter(
      (sample) =>
        sample.contextBucket === contextBucket &&
        sample.risk === classification.features.risk &&
        sample.interactivity === classification.features.interactivity &&
        sample.languageBucket === languageBucket,
    );
    const archetype = classification.archetype.archetype;
    if (
      (archetype === "implementation_planning" || archetype === "large_program_planning") &&
      !pi.getActiveTools().includes("submit_implementation_plan")
    ) {
      return {
        registry,
        decision: {
          kind: "unroutable",
          policyVersion: POLICY_VERSION,
          archetype,
          reason: "planning route requires the active submit_implementation_plan validator tool",
          exclusions: [],
        },
      };
    }
    // A standalone review has no tracked builder provenance. Route it from the classified delta
    // shape just like any other task; builder-relative vendor exclusion is reserved for generated
    // reviews whose parent lease identifies the actual builder.
    const routingContext = deriveRoutingContext(classification.features, languageBuckets);
    return {
      registry,
      decision:
        archetype === "code_review"
          ? selectStandaloneReviewRoute(registry, requirements, routeSamples, undefined, explorationKey, routingContext)
          : selectOrdinaryRoute(
              archetype,
              registry,
              requirements,
              routeSamples,
              undefined,
              explorationKey,
              routingContext,
            ),
    };
  }

  function leasedChoiceEligible(ctx: ExtensionContext, lease: TaskLease, hasImages: boolean): boolean {
    const registry = buildRegistrySnapshot(ctx, scope);
    const model = registry.find(
      (candidate) => candidate.provider === lease.selected.provider && candidate.modelId === lease.selected.modelId,
    );
    if (!model?.available) return false;
    const requirements = routeRequirements(currentTokens(ctx), lease.features, hasImages);
    if (bedrockSolLongContextPricingUnavailable(model, requirements.estimatedFinishedTokens)) return false;
    if (requirements.estimatedFinishedTokens > Math.floor(model.contextWindow * 0.7)) return false;
    if (requirements.requiresImages && !model.inputTypes.includes("image")) return false;
    if (requirements.requiresTools && !model.toolCapable) return false;
    if (!model.supportedEfforts.includes(lease.selected.effort)) return false;
    // A persisted lease is valid only while its exact profile pairing remains available in the live registry.
    return (
      findPromptProfile(model.vendor, model.modelId, lease.archetype, lease.selected.effort)?.id ===
      lease.promptProfileId
    );
  }

  async function applyChoice(ctx: ExtensionContext, choice: RouteChoice): Promise<boolean> {
    applyingSelection = true;
    try {
      if (ctx.model?.provider === choice.provider && ctx.model.id === choice.modelId) {
        if (pi.getThinkingLevel() !== choice.effort) pi.setThinkingLevel(choice.effort);
        return true;
      }
      const model = ctx.modelRegistry.find(choice.provider, choice.modelId);
      if (!model) return false;
      const selected = await pi.setModel(model);
      if (!selected) return false;
      pi.setThinkingLevel(choice.effort);
      return true;
    } catch {
      return false;
    } finally {
      applyingSelection = false;
    }
  }

  async function applyWithAvailabilityFallback(
    ctx: ExtensionContext,
    lease: TaskLease,
  ): Promise<TaskLease | undefined> {
    let candidate = lease;
    while (!(await applyChoice(ctx, candidate.selected))) {
      const fallback = resolveFallback(candidate, "availability", new Date().toISOString());
      await record(
        ctx,
        "fallback",
        {
          action: fallback.action,
          reason: fallback.reason,
          failure: "availability",
          failedSelection: candidate.selected,
          ...(fallback.action === "use_choice" ? { nextSelection: fallback.choice } : {}),
        },
        {
          taskId: candidate.taskId,
          routeKey: candidate.archetype,
          archetype: candidate.archetype,
          provider: candidate.selected.provider,
          modelId: candidate.selected.modelId,
          effort: candidate.selected.effort,
          promptProfileId: candidate.promptProfileId,
          policyVersion: candidate.policyVersion,
          modelSnapshotId: candidate.modelSnapshotId,
        },
      );
      if (fallback.action !== "use_choice") {
        if (fallback.action === "restore_previous" && fallback.choice) await applyChoice(ctx, fallback.choice);
        return undefined;
      }
      candidate = fallback.lease;
    }
    return candidate;
  }

  async function restoreParentAfterReview(
    ctx: ExtensionContext,
    child: TaskLease,
    outcome: "completed" | "skipped",
  ): Promise<void> {
    if (!child.parentLease || child.lifecycle.phase !== "review") return;
    const now = new Date().toISOString();
    const submission = outcome === "completed" ? child.lifecycle.submission : undefined;
    const reviewOutcome: ReviewOutcome = {
      kind: child.lifecycle.reviewKind,
      ...(submission ? { verdict: submission.verdict } : {}),
      summary: submission?.summary ?? "Independent review was unavailable or did not produce a validated verdict.",
      reviewTaskId: child.taskId,
      completedAt: now,
    };
    const original = child.parentLease;
    let lifecycle: LeaseLifecycle = original.lifecycle;
    let triggerContinuation = false;

    if (child.lifecycle.reviewKind === "authorization") {
      const plan = original.lifecycle.phase === "preflight" ? original.lifecycle.plan : undefined;
      const approved =
        submission?.verdict === "approve" &&
        plan !== undefined &&
        child.lifecycle.scopeFingerprint ===
          safetyFingerprint({
            taskFingerprint: original.lifecycle.taskFingerprint,
            planFingerprint: plan.planFingerprint,
          }) &&
        child.selected.vendor !== original.selected.vendor;
      lifecycle = approved
        ? {
            phase: "authorized_execution",
            policy: "authorization_then_completion_review",
            taskFingerprint: original.lifecycle.taskFingerprint,
            plan,
            authorization: {
              taskFingerprint: original.lifecycle.taskFingerprint,
              planFingerprint: plan.planFingerprint,
              reviewTaskId: child.taskId,
              reviewerVendor: child.selected.vendor,
              sessionId: ctx.sessionManager.getSessionId(),
              approvedAt: now,
            },
          }
        : {
            phase: "preflight",
            policy: "authorization_then_completion_review",
            taskFingerprint: original.lifecycle.taskFingerprint,
            ...(plan ? { plan } : {}),
            lastAuthorizationReview: reviewOutcome,
          };
      triggerContinuation = approved;
    } else if (child.lifecycle.reviewKind === "advisory") {
      lifecycle = {
        phase: "ready_after_advisory",
        policy: "advisory_then_completion_review",
        taskFingerprint: original.lifecycle.taskFingerprint,
        advisory: reviewOutcome,
      };
      // Advice is deliberately not authorization. Even a cautionary or unavailable opinion completes
      // the consultation step; the builder remains responsible for deciding how to proceed.
      triggerContinuation = true;
    } else {
      const source = original.lifecycle;
      lifecycle = {
        phase: "completed",
        policy: source.policy === "ordinary" ? "completion_review" : source.policy,
        taskFingerprint: source.taskFingerprint,
        completionReview: reviewOutcome,
        ...(source.phase === "authorized_execution" ? { plan: source.plan, authorization: source.authorization } : {}),
        ...(source.phase === "ready_after_advisory" ? { advisory: source.advisory } : {}),
      };
    }

    const parent = { ...original, updatedAt: now, lifecycle };
    await applyChoice(ctx, parent.selected);
    state = installLease(state, parent);
    const reviewMetrics = lastAttemptMetrics;
    // Cost, wall time, and retry are task-level totals, so the review's share is added to the
    // parent. Cache-token counts are deliberately NOT summed: they are a per-endpoint observation,
    // and an independent review always runs on a different vendor's endpoint. Folding its counts in
    // would attribute one endpoint's cache behavior to another and corrupt the Bedrock-versus-direct
    // cache-ratio comparison that FW3 exists to measure.
    lastAttemptMetrics = reviewParentAttemptMetrics
      ? {
          ...reviewParentAttemptMetrics,
          modelAndToolCost: reviewParentAttemptMetrics.modelAndToolCost + (reviewMetrics?.modelAndToolCost ?? 0),
          wallTimeMs: reviewParentAttemptMetrics.wallTimeMs + (reviewMetrics?.wallTimeMs ?? 0),
          retried: reviewParentAttemptMetrics.retried || (reviewMetrics?.retried ?? false),
        }
      : undefined;
    reviewParentAttemptMetrics = undefined;
    persistState();
    updateStatus(ctx);
    await record(
      ctx,
      "outcome",
      {
        reviewOutcome: outcome,
        reviewKind: child.lifecycle.reviewKind,
        verdict: submission?.verdict,
        reviewTaskId: child.taskId,
        parentTaskId: parent.taskId,
        executionAuthorized: lifecycle.phase === "authorized_execution",
      },
      { taskId: parent.taskId, archetype: parent.archetype },
    );
    if (triggerContinuation) {
      pi.sendMessage(
        {
          customType: CONTEXT_MESSAGE,
          content:
            lifecycle.phase === "authorized_execution"
              ? "The exact reviewed action plan is authorized for this task and session. Execute only that plan; stop if its preconditions, targets, or steps change."
              : `The pre-action advisor reported: ${reviewOutcome.summary}\nProceed only within the original task scope and account for the advice.`,
          display: true,
          details: { parentTaskId: parent.taskId, reviewTaskId: child.taskId, reviewKind: child.lifecycle.reviewKind },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    }
  }

  async function transitionFallback(ctx: ExtensionContext, failure: FailureKind, triggerTurn: boolean): Promise<void> {
    const active = state.active;
    if (!active || state.mode !== "active" || active.executionFailed) return;
    const fallback = resolveFallback(active, failure, new Date().toISOString());
    await record(
      ctx,
      "fallback",
      {
        action: fallback.action,
        reason: fallback.reason,
        failure,
        // Preserve the failed selection separately from the next choice for an auditable fallback chain.
        failedSelection: active.selected,
        ...(fallback.action === "use_choice"
          ? { nextSelection: fallback.choice, reviewFellBackToBuilder: fallback.reviewFellBackToBuilder }
          : {}),
      },
      {
        taskId: active.taskId,
        routeKey: active.archetype,
        archetype: active.archetype,
        provider: active.selected.provider,
        modelId: active.selected.modelId,
        effort: active.selected.effort,
        promptProfileId: active.promptProfileId,
        policyVersion: active.policyVersion,
        modelSnapshotId: active.modelSnapshotId,
      },
    );
    if (fallback.action === "use_choice") {
      if (!(await applyChoice(ctx, fallback.choice))) {
        attemptDisposition = "failed";
        return;
      }
      const fallbackLease =
        fallback.lease.lifecycle.phase === "review"
          ? {
              ...fallback.lease,
              lifecycle: {
                phase: "review" as const,
                policy: "ordinary" as const,
                taskFingerprint: fallback.lease.lifecycle.taskFingerprint,
                reviewKind: fallback.lease.lifecycle.reviewKind,
                scopeFingerprint: fallback.lease.lifecycle.scopeFingerprint,
              },
            }
          : fallback.lease;
      state = installLease(state, fallbackLease);
      attemptDisposition = "pending";
      attemptStartedAt = Date.now();
      attemptTurns = 0;
      attemptToolCalls = 0;
      deterministicCheckCalls.clear();
      deterministicCheckResults.clear();
      potentiallyMutatingCalls.clear();
      persistState();
      updateStatus(ctx);
      if (triggerTurn) {
        pi.sendMessage(
          {
            customType: CONTEXT_MESSAGE,
            content:
              "The previous routed attempt failed. Continue the same task with existing evidence; do not broaden scope.",
            display: false,
            details: { taskId: active.taskId, fallbackReason: failure },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      }
      return;
    }
    if (fallback.action === "restore_previous") {
      attemptDisposition = "failed";
      if (fallback.choice) await applyChoice(ctx, fallback.choice);
      state = installLease(state, { ...fallback.lease, executionFailed: true });
      persistState();
      updateStatus(ctx);
    }
    if (fallback.action === "skip_review" && active.lifecycle.phase === "review") {
      attemptDisposition = "failed";
      await restoreParentAfterReview(ctx, active, "skipped");
    }
    ctx.ui.notify(fallback.reason, fallback.action === "skip_review" ? "warning" : "error");
  }

  async function startIndependentReview(
    ctx: ExtensionContext,
    parent: TaskLease,
    reviewKind: SafetyReviewKind,
    scopeFingerprint: string,
    evidenceInstructions: string,
  ): Promise<void> {
    if (state.mode !== "active" || parent.lifecycle.phase === "review" || parent.archetype === "code_review") {
      return;
    }
    const registry = buildRegistrySnapshot(ctx, scope);
    const builder = registry.find(
      (candidate) => candidate.provider === parent.selected.provider && candidate.modelId === parent.selected.modelId,
    );
    if (!builder) return;
    const decision = selectReviewRoute(
      registry,
      routeRequirements(currentTokens(ctx), parent.features, false),
      builder,
      parent.selected.effort,
      parent.selected.ability,
    );
    if (decision.kind !== "review") {
      await record(
        ctx,
        "route_decision",
        {
          kind: "unroutable_review",
          reason: decision.kind === "unroutable" ? decision.reason : "review selector returned an ordinary route",
          exclusions: decision.exclusions,
        },
        {
          taskId: parent.taskId,
          routeKey: "code_review",
          archetype: parent.archetype,
          policyVersion: decision.policyVersion,
          modelSnapshotId: registrySnapshotId(registry),
        },
      );
      ctx.ui.notify("Required independent review is unroutable; inspect router telemetry before continuing", "error");
      return;
    }
    reviewParentAttemptMetrics = lastAttemptMetrics;
    lastAttemptMetrics = undefined;
    const now = new Date().toISOString();
    const reviewFeatures = {
      ...parent.features,
      intent: "review" as const,
      workflowType: "code_review" as const,
      actionMode: "local_read" as const,
      reviewIntent: true,
      independenceRequirement: "different_vendor_review" as const,
      taskContinuity: "new_task" as const,
    };
    const child = createTaskLease({
      taskId: randomUUID(),
      parentTaskId: parent.taskId,
      parentLease: parent,
      lifecycle: {
        phase: "review",
        policy: "ordinary",
        taskFingerprint: parent.lifecycle.taskFingerprint,
        reviewKind,
        scopeFingerprint,
      },
      safetyEvidence: parent.safetyEvidence,
      startedAt: now,
      updatedAt: now,
      archetype: "code_review",
      features: reviewFeatures,
      selected: decision.primary,
      // Generated reviews never fall back to the tracked builder. In particular, a builder verdict
      // can never authorize its own potentially irreversible plan.
      fallbacks: [decision.fallback],
      modelSnapshotId: registrySnapshotId(registry),
      policyVersion: decision.policyVersion,
      lastPromptFingerprint: promptFingerprint(`review:${reviewKind}:${parent.taskId}:${scopeFingerprint}`),
      ...(parent.repositoryLanguageBucket ? { repositoryLanguageBucket: parent.repositoryLanguageBucket } : {}),
      ...(parent.contextSizeBucket ? { contextSizeBucket: parent.contextSizeBucket } : {}),
    });
    const applied = await applyWithAvailabilityFallback(ctx, child);
    if (!applied) {
      await restoreParentAfterReview(ctx, child, "skipped");
      return;
    }
    state = installLease(state, applied);
    accumulatedTaskCosts.set(applied.taskId, 0);
    taskStartedAt.set(applied.taskId, Date.now());
    persistState();
    updateStatus(ctx);
    attemptStartedAt = Date.now();
    attemptTurns = 0;
    attemptToolCalls = 0;
    deterministicCheckCalls.clear();
    deterministicCheckResults.clear();
    potentiallyMutatingCalls.clear();
    await record(
      ctx,
      "route_decision",
      {
        kind: "required_independent_review",
        reviewKind,
        scopeFingerprint,
        parentTaskId: parent.taskId,
        selection: decision.primary,
        exclusions: decision.exclusions,
        ceilingMismatchVendors: decision.ceilingMismatchVendors,
        fallbacks: applied.fallbacks.map((choice) => `${choice.provider}/${choice.modelId}`),
      },
      {
        taskId: applied.taskId,
        routeKey: "code_review",
        archetype: "code_review",
        provider: applied.selected.provider,
        modelId: applied.selected.modelId,
        effort: applied.selected.effort,
        promptProfileId: applied.promptProfileId,
        policyVersion: applied.policyVersion,
        modelSnapshotId: applied.modelSnapshotId,
      },
    );
    attemptDisposition = "pending";
    pi.sendMessage(
      {
        customType: CONTEXT_MESSAGE,
        content: [
          `Perform the ${reviewKind} independent review for tracked parent task ${parent.taskId}.`,
          `Review scope fingerprint: ${scopeFingerprint}`,
          evidenceInstructions,
          "Do not edit files or mutate repository, runtime, or external state.",
          `Call submit_safety_review exactly once with reviewKind=${reviewKind} and the exact scope fingerprint. A prose-only response is not a valid review.`,
        ].join("\n"),
        display: true,
        details: { parentTaskId: parent.taskId, reviewTaskId: applied.taskId },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }

  async function collectCompletionEvidence(
    ctx: ExtensionContext,
    parent: TaskLease,
  ): Promise<{ evidence?: CompletionEvidence; reason?: string }> {
    const repository = await readRepositoryMetadata(pi, ctx.cwd);
    const baselineHead = parent.safetyEvidence.baselineHead;
    let diffText = "";
    let diffCaptured = false;
    try {
      const result = await pi.exec(
        "git",
        ["-C", ctx.cwd, "diff", "--no-ext-diff", "--binary", baselineHead ?? "HEAD", "--"],
        { timeout: 10_000 },
      );
      if (result.code === 0) {
        diffText = result.stdout;
        diffCaptured = true;
      }
    } catch {
      // Missing git evidence is handled by the validation below; it never degrades to authorization.
    }
    const changedFiles = [...new Set(repository.changedFiles)].sort();
    const repositoryChanged =
      changedFiles.length > 0 ||
      (baselineHead !== undefined && repository.head !== undefined && repository.head !== baselineHead);
    const latestChecks = new Map(parent.safetyEvidence.checks.map((check) => [check.command, check]));
    const checks = [...latestChecks.values()];
    const codeBuilder = isCodeBuilder(parent.features);
    if (codeBuilder && parent.safetyEvidence.mutations.length === 0) {
      return { reason: "no successful implementation mutation was recorded for this task" };
    }
    if (codeBuilder && !repositoryChanged)
      return { reason: "no repository delta exists relative to the task baseline" };
    if (codeBuilder && (checks.length === 0 || checks.some((check) => !check.passed))) {
      return { reason: "post-build review requires passing latest deterministic checks and no unresolved failures" };
    }
    if (codeBuilder && repositoryChanged && !diffCaptured) {
      return { reason: "the repository changed but its diff could not be captured for review evidence" };
    }
    if (!codeBuilder && parent.safetyEvidence.mutations.length === 0) {
      return { reason: "no successful mutation evidence was recorded for completion review" };
    }
    const partial = {
      taskFingerprint: parent.lifecycle.taskFingerprint,
      ...(baselineHead ? { baselineHead } : {}),
      ...(repository.head ? { completedHead: repository.head } : {}),
      changedFiles,
      ...(repositoryChanged && diffCaptured
        ? {
            diffFingerprint: safetyFingerprint({
              baselineHead,
              completedHead: repository.head,
              changedFiles,
              diffText,
            }),
          }
        : {}),
      checks,
      mutations: parent.safetyEvidence.mutations,
    };
    return { evidence: { ...partial, evidenceFingerprint: safetyFingerprint(partial) } };
  }

  async function prepareActiveLeaseForTurn(
    ctx: ExtensionContext,
    active: TaskLease,
    pending: PendingInput | undefined,
  ): Promise<TaskLease | undefined> {
    if (active.manualOverride || state.manualOverride) return undefined;
    if (state.mode === "active" && pending && active.lifecycle.phase === "completed") {
      active = {
        ...active,
        lifecycle: resumeCompletedLifecycle(active.lifecycle, ctx.sessionManager.getSessionId()),
        updatedAt: new Date().toISOString(),
      };
      state = installLease(state, active);
      persistState();
    }
    updateStatus(ctx);
    if (state.mode === "shadow") {
      ctx.ui.notify(
        `Shadow route: ${active.archetype} → ${active.selected.provider}/${active.selected.modelId} (${active.selected.effort})`,
        "info",
      );
      return undefined;
    }
    while (!active.executionFailed && !leasedChoiceEligible(ctx, active, pending?.hasImages ?? false)) {
      const previousAttempt = active.attemptIndex;
      await transitionFallback(ctx, "availability", false);
      const next = state.active;
      if (!next || next.executionFailed || next.attemptIndex === previousAttempt) return undefined;
      active = next;
    }
    if (!leasedChoiceEligible(ctx, active, pending?.hasImages ?? false)) return undefined;
    const applied = await applyWithAvailabilityFallback(ctx, active);
    if (!applied) {
      state = installLease(state, { ...active, executionFailed: true });
      persistState();
      updateStatus(ctx);
      return undefined;
    }
    if (applied !== active) {
      state = installLease(state, applied);
      persistState();
    }
    return applied;
  }

  pi.registerTool({
    name: "submit_action_plan",
    label: "Validate irreversible-action plan",
    description:
      "Submit a concrete irreversible-action plan only when router context explicitly says the active safety lifecycle is preflight. Never infer preflight from the action itself. Validation does not authorize execution; a separate independent review must approve the exact task/plan fingerprint.",
    parameters: ActionPlanSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const active = state.active;
      if (active?.lifecycle.phase !== "preflight") {
        throw new Error("submit_action_plan is only valid inside an irreversible-action preflight lease");
      }
      const validation = validateActionPlan(params);
      await record(
        ctx,
        "outcome",
        {
          actionPlanValidated: validation.success,
          validationErrors: validation.success ? [] : validation.errors,
          ...(validation.success ? { planFingerprint: validation.fingerprint } : {}),
        },
        { taskId: active.taskId, archetype: active.archetype },
      );
      if (!validation.success) throw new Error(`Invalid irreversible-action plan: ${validation.errors.join("; ")}`);
      const plan = {
        taskFingerprint: active.lifecycle.taskFingerprint,
        planFingerprint: validation.fingerprint,
        submittedAt: new Date().toISOString(),
        plan: validation.plan,
      };
      state = installLease(state, {
        ...active,
        updatedAt: plan.submittedAt,
        lifecycle: {
          phase: "preflight",
          policy: "authorization_then_completion_review",
          taskFingerprint: active.lifecycle.taskFingerprint,
          plan,
        },
      });
      persistState();
      updateStatus(ctx);
      return {
        content: [
          {
            type: "text",
            text: `Validated irreversible-action plan ${validation.fingerprint}. Execution remains blocked pending independent authorization review.`,
          },
        ],
        details: { planFingerprint: validation.fingerprint, taskFingerprint: active.lifecycle.taskFingerprint },
      };
    },
  });

  pi.registerTool({
    name: "submit_safety_review",
    label: "Submit scoped safety review",
    description:
      "Submit a verdict only when router context explicitly identifies a generated read-only review lease. Never use this for an ordinary user-requested review. The review kind and scope fingerprint must exactly match the active lease.",
    parameters: SafetyReviewSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const active = state.active;
      if (active?.lifecycle.phase !== "review") {
        throw new Error("submit_safety_review is only valid inside a generated independent review lease");
      }
      if (active.lifecycle.submission) {
        throw new Error("submit_safety_review may be called only once for a generated review attempt");
      }
      const validation = validateSafetyReview(params, active.lifecycle.reviewKind, active.lifecycle.scopeFingerprint);
      await record(
        ctx,
        "outcome",
        {
          safetyReviewValidated: validation.success,
          reviewKind: active.lifecycle.reviewKind,
          scopeFingerprint: active.lifecycle.scopeFingerprint,
          validationErrors: validation.success ? [] : validation.errors,
        },
        { taskId: active.taskId, archetype: active.archetype },
      );
      if (!validation.success) throw new Error(`Invalid safety review: ${validation.errors.join("; ")}`);
      state = installLease(state, {
        ...active,
        updatedAt: new Date().toISOString(),
        lifecycle: { ...active.lifecycle, submission: validation.submission },
      });
      persistState();
      return {
        content: [
          {
            type: "text",
            text: `Recorded ${active.lifecycle.reviewKind} verdict ${validation.submission.verdict} for ${active.lifecycle.scopeFingerprint}.`,
          },
        ],
        details: validation.submission,
      };
    },
  });

  pi.registerTool({
    name: "submit_implementation_plan",
    label: "Validate implementation plan",
    description:
      "Submit a complete implementation-plan DAG. Required on implementation_planning and large_program_planning routes. Validates IDs, dependencies, cycles, acceptance criteria, rollout, and rollback.",
    parameters: ProgramPlanSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const active = state.active;
      if (
        !active ||
        (active.archetype !== "implementation_planning" && active.archetype !== "large_program_planning")
      ) {
        throw new Error("submit_implementation_plan is only valid inside a planning lease");
      }
      const validation = validateProgramPlan(params);
      await record(
        ctx,
        "outcome",
        {
          planValidated: validation.success,
          validationErrors: validation.errors,
          topologicalOrder: validation.topologicalOrder,
        },
        { taskId: active.taskId, archetype: active.archetype },
      );
      if (!validation.success) throw new Error(`Invalid implementation plan: ${validation.errors.join("; ")}`);
      validatedPlanAttempts.add(`${active.taskId}:${String(active.attemptIndex)}:${String(agentRunSequence)}`);
      return {
        content: [
          {
            type: "text",
            text: `Validated implementation-plan DAG (${String(validation.topologicalOrder.length)} PRs): ${validation.topologicalOrder.join(" -> ")}`,
          },
        ],
        details: { plan: params, topologicalOrder: validation.topologicalOrder },
      };
    },
  });

  pi.on("session_shutdown", async (event) => {
    if (event.reason === "new") modeForNextSession = state.mode;
    // /clear, /resume, /fork, /reload, and quit all pass through here, so this is the one place that
    // sees the mode in force when a session ends.
    await rememberMode(state.mode);
  });

  pi.on("session_start", async (event, ctx) => {
    attemptDisposition = "unknown";
    // Re-read on every session start so a settings edit or a fresh probe takes effect on /reload.
    scope = await readRouterScope(ctx.cwd);
    const branch = ctx.sessionManager.getBranch();
    // A session that already carries router state keeps it, and /reload keeps the running mode.
    // Configuration only decides what a session with no router history of its own starts as.
    const needsStartMode = event.reason !== "reload" && !hasPersistedRouterState(branch);
    const carriedMode = event.reason === "new" ? modeForNextSession : undefined;
    modeForNextSession = undefined;
    if (repoKeyCwd !== ctx.cwd) {
      repoKey = await resolveRouterRepoKey(pi, ctx.cwd);
      repoKeyCwd = ctx.cwd;
      recordedExitMode = undefined;
    }
    const modeBeforeStart = state.mode;
    let resolvedStartMode: RouterMode | undefined;
    if (needsStartMode && carriedMode === undefined) {
      const resolution = await readStartModeResolution({ agentDir: getAgentDir(), repoKey });
      recordedExitMode = resolution.lastKnownMode;
      resolvedStartMode = resolution.mode;
    }
    const fallbackMode = carriedMode ?? resolvedStartMode ?? state.mode;
    state = restoreLeaseState(branch, fallbackMode);
    if (
      state.active?.lifecycle.phase === "authorized_execution" &&
      state.active.lifecycle.authorization.sessionId !== ctx.sessionManager.getSessionId()
    ) {
      state = { ...state, active: invalidateAuthorization(state.active, "session boundary") };
      persistState();
    }
    if (event.reason !== "reload" && state.active?.lifecycle.phase === "review") {
      // A generated review cannot cross into a new/forked session and later restore or authorize its
      // nested parent. The next user turn starts a fresh task under the hard-boundary gate.
      state = { mode: state.mode, manualOverride: false };
      persistState();
    }
    nextParentTaskId = event.reason === "fork" ? state.active?.taskId : undefined;
    if (event.reason !== "reload") state = setHardBoundary(state, event.reason === "fork" ? "subagent" : "new_session");
    if (carriedMode !== undefined) {
      state = { ...state, mode: carriedMode };
      persistState();
    } else if (resolvedStartMode !== undefined && resolvedStartMode !== modeBeforeStart) {
      // Only a start mode that actually changes enablement is worth a session entry; recording the
      // unchanged default on every launch would add history without adding information.
      persistState();
    }
    const repository = await readRepositoryMetadata(pi, ctx.cwd);
    lastUpstream = repository.upstream;
    updateStatus(ctx);
  });

  pi.on("session_compact", async (_event, ctx) => {
    // Compaction rewrites history, not enablement: the lease is dropped at the boundary while the
    // mode stays in force, and re-persisting it puts the mode after the compaction cut so a later
    // resume of this session still sees it. Invalidate authorization before dropping the lease so
    // no approval can survive the compaction boundary.
    if (state.active) state = { ...state, active: invalidateAuthorization(state.active, "compaction boundary") };
    state = setHardBoundary(state, "post_compaction");
    persistState();
    await rememberMode(state.mode);
    await record(ctx, "boundary", { boundary: "post_compaction" }, state.active ? { taskId: state.active.taskId } : {});
  });

  pi.on("session_before_fork", async (_event, ctx) => {
    await record(
      ctx,
      "boundary",
      { boundary: "subagent_fork_requested" },
      state.active ? { taskId: state.active.taskId } : {},
    );
  });

  pi.on("input", (event, ctx) => {
    // The next task boundary is not known yet. Remove phase-scoped validators before Pi builds
    // the turn prompt; before_agent_start restores exactly the validator accepted by the lease.
    syncSafetyLifecycleTools(undefined);
    if (state.mode === "off") return { action: "continue" as const };
    if (
      state.active &&
      (state.active.lifecycle.phase === "authorized_execution" ||
        (state.active.lifecycle.phase === "completed" &&
          state.active.lifecycle.policy === "authorization_then_completion_review")) &&
      event.source !== "extension"
    ) {
      state = { ...state, active: invalidateAuthorization(state.active, "new user input") };
      persistState();
    }
    const cache = cacheEstimate(ctx.sessionManager.getBranch());
    let gate = deterministicBoundaryGate(state, {
      isUserInput: true,
      source: event.source,
      ...(event.streamingBehavior ? { streamingBehavior: event.streamingBehavior } : {}),
      prompt: event.text,
      cachedTokens: cache.cachedTokens,
      expectedReuseRatio: cache.expectedReuseRatio,
    });
    const hasImages = Boolean(event.images?.length);
    if (hasImages && state.active) {
      const selected = buildRegistrySnapshot(ctx, scope).find(
        (candidate) =>
          candidate.provider === state.active?.selected.provider && candidate.modelId === state.active.selected.modelId,
      );
      if (!selected?.inputTypes.includes("image")) {
        gate = { action: "new_task", reason: "image input requires a newly eligible route" };
      }
    }
    pendingInput = {
      gate,
      repository: readRepositoryMetadata(pi, ctx.cwd, event.text),
      cache,
      hasImages,
      source: event.source,
    };
    lastRoute = { boundaryReason: gate.reason };
    ctx.ui.setWorkingMessage("Routing...");
    ctx.ui.setWorkingVisible(true);
    return { action: "continue" as const };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    let exposedSafetyLifecycle: LeaseLifecycle | undefined;
    if (state.mode === "off") {
      syncSafetyLifecycleTools(undefined);
      return;
    }
    try {
      const pending = pendingInput;
      pendingInput = undefined;
      const repository = pending ? await pending.repository : await readRepositoryMetadata(pi, ctx.cwd);
      if (pending && lastUpstream && repository.upstream && repository.upstream !== lastUpstream) {
        state = setHardBoundary(state, "post_push");
        pending.gate = { action: "new_task", reason: "hard boundary: post_push", hardBoundary: "post_push" };
      }
      lastUpstream = repository.upstream;
      if (pending) {
        lastRoute = { boundaryReason: pending.gate.reason };
        await record(
          ctx,
          "boundary",
          { action: pending.gate.action, reason: pending.gate.reason, cache: pending.cache, source: pending.source },
          state.active ? { taskId: state.active.taskId } : {},
        );
      }
      // Classification, builder provenance, and route selection consume the exact same
      // operator-scoped snapshot. The classifier never reconstructs candidates from the
      // process-wide available-model list, and this turn never reads the registry twice.
      const registry = buildRegistrySnapshot(ctx, scope);
      const currentSynopsis = synopsis(
        ctx,
        repository,
        Boolean(repository.reviewDelta) || isStandaloneReviewRequest(event.prompt),
        registry,
      );
      const turnClassification = await classifyTurn(
        ctx,
        registry,
        event.prompt,
        currentSynopsis,
        pending,
        state.active,
      );
      let active = turnClassification.active;
      const classification = turnClassification.classification;
      const requiresNewLease = turnClassification.requiresNewLease;
      if (turnClassification.boundaryReason) lastRoute.boundaryReason = turnClassification.boundaryReason;

      if (requiresNewLease && classification) {
        const routedClassification = classification;
        const sanitizedClassifierOutput = sanitizeClassifierFeatures(routedClassification.features);
        const sanitizedPrimaryClassifierOutput = routedClassification.primaryFeatures
          ? sanitizeClassifierFeatures(routedClassification.primaryFeatures)
          : undefined;
        const sanitizedSecondaryClassifierOutput = routedClassification.secondaryFeatures
          ? sanitizeClassifierFeatures(routedClassification.secondaryFeatures)
          : undefined;
        const sanitizedClassifierAttempts = routedClassification.attempts.map(sanitizeClassifierAttempt);
        for (const attempt of sanitizedClassifierAttempts) {
          await record(
            ctx,
            "classifier_attempt",
            { ...attempt },
            {
              archetype: routedClassification.archetype.archetype,
              ...(attempt.provider ? { provider: attempt.provider } : {}),
              ...(attempt.modelId ? { modelId: attempt.modelId } : {}),
            },
          );
        }
        const languageBucket = repository.languageBuckets.join("+") || "unknown";
        const contextBucket = contextSizeBucket(ctx, routedClassification.features);
        const routed = await withRouterSpan(
          ctx.sessionManager.getSessionId(),
          "router.route",
          {
            "router.mode": state.mode,
            "router.archetype": routedClassification.archetype.archetype,
            "router.risk": routedClassification.features.risk,
          },
          async (span) => {
            const result = await route(
              ctx,
              registry,
              routedClassification,
              pending?.hasImages ?? Boolean(event.images?.length),
              languageBucket,
              repository.languageBuckets,
              contextBucket,
              promptFingerprint(event.prompt),
            );
            annotateRouterSpan(span, {
              "router.decision": result.decision.kind,
              ...(result.decision.kind === "unroutable"
                ? {}
                : {
                    "router.provider": result.decision.primary.provider,
                    "router.model": result.decision.primary.modelId,
                    "router.profile": result.decision.primary.profileId,
                  }),
            });
            return result;
          },
        );
        lastRoute = { ...lastRoute, classification: routedClassification, decision: routed.decision };
        if (routed.decision.kind === "unroutable") {
          await record(
            ctx,
            "route_decision",
            {
              kind: "unroutable",
              reason: routed.decision.reason,
              exclusions: routed.decision.exclusions,
              classifierOutput: sanitizedClassifierOutput,
              classifierAttempts: sanitizedClassifierAttempts,
            },
            {
              routeKey: routed.decision.archetype,
              archetype: routed.decision.archetype,
              policyVersion: routed.decision.policyVersion,
              modelSnapshotId: registrySnapshotId(routed.registry),
            },
          );
          ctx.ui.notify(`Router retained current model: ${routed.decision.reason}`, "warning");
          return;
        }
        const now = new Date().toISOString();
        const currentSnapshot = snapshotForModel(ctx.model, routed.registry);
        const currentEffort = pi.getThinkingLevel();
        const priorSelection = previousChoice(currentSnapshot, currentEffort, routed.decision.archetype);
        const preserveManualSelection = state.manualOverride || state.active?.manualOverride === true;
        const routeChoices = routeChoicesForNewLease(
          routed.decision.primary,
          routed.decision.kind === "review" ? [routed.decision.fallback] : routed.decision.fallbacks,
          priorSelection,
          preserveManualSelection,
        );
        const taskFingerprint = safetyFingerprint({
          prompt: event.prompt,
          repositoryRoot: repository.root,
          baselineHead: repository.head,
        });
        const safetyPolicy = deriveSafetyPolicy(routedClassification.features);
        const lease = createTaskLease({
          taskId: randomUUID(),
          ...(nextParentTaskId && routed.decision.archetype !== "code_review"
            ? { parentTaskId: nextParentTaskId }
            : {}),
          startedAt: now,
          updatedAt: now,
          archetype: routed.decision.archetype,
          features: routedClassification.features,
          selected: routeChoices.selected,
          ...(routeChoices.previousSelection ? { previousSelection: routeChoices.previousSelection } : {}),
          fallbacks: routeChoices.fallbacks,
          modelSnapshotId: registrySnapshotId(routed.registry),
          policyVersion: routed.decision.policyVersion,
          lastPromptFingerprint: promptFingerprint(event.prompt),
          lifecycle: initialLifecycle(safetyPolicy, taskFingerprint),
          safetyEvidence: {
            ...(repository.head ? { baselineHead: repository.head } : {}),
            baselineChangedFiles: [...repository.changedFiles],
            checks: [],
            mutations: [],
          },
          repositoryLanguageBucket: languageBucket,
          contextSizeBucket: contextBucket,
        });
        state = installLease(state, lease);
        accumulatedTaskCosts.set(lease.taskId, 0);
        taskStartedAt.set(lease.taskId, Date.now());
        nextParentTaskId = undefined;
        persistState();
        active = lease;
        attemptStartedAt = Date.now();
        attemptTurns = 0;
        attemptToolCalls = 0;
        deterministicCheckCalls.clear();
        deterministicCheckResults.clear();
        potentiallyMutatingCalls.clear();
        await record(
          ctx,
          "route_decision",
          {
            kind: routed.decision.kind,
            confidence: routedClassification.features.confidence,
            risk: routedClassification.features.risk,
            failedClosed: routedClassification.failedClosed,
            safetyPolicy,
            lifecyclePhase: lease.lifecycle.phase,
            exclusions: routed.decision.exclusions,
            selection: lease.selected,
            manualSelectionPreserved: preserveManualSelection && priorSelection !== undefined,
            telemetryMature: routed.decision.telemetryMature,
            controlledHoldout: routed.decision.kind === "ordinary" ? routed.decision.controlledHoldout : false,
            fallbacks: lease.fallbacks.map((choice) => `${choice.provider}/${choice.modelId}`),
            classifierOutput: sanitizedClassifierOutput,
            primaryClassifierOutput: sanitizedPrimaryClassifierOutput,
            secondaryClassifierOutput: sanitizedSecondaryClassifierOutput,
            classifierAttempts: sanitizedClassifierAttempts,
          },
          {
            taskId: lease.taskId,
            routeKey: lease.archetype,
            archetype: lease.archetype,
            provider: lease.selected.provider,
            modelId: lease.selected.modelId,
            effort: lease.selected.effort,
            promptProfileId: lease.promptProfileId,
            policyVersion: lease.policyVersion,
            modelSnapshotId: lease.modelSnapshotId,
          },
        );
      }

      if (!active) return;
      active = await prepareActiveLeaseForTurn(ctx, active, pending);
      if (!active) return;
      const profile = PROMPT_PROFILES.find((candidate) => candidate.id === active.promptProfileId);
      if (!profile) return;
      exposedSafetyLifecycle = active.lifecycle;
      const safetyContext = safetyContextForLifecycle(active.lifecycle);
      const compiled = compilePrompt({
        baseSystemPrompt: safetyContext ? `${event.systemPrompt}\n\n${safetyContext}` : event.systemPrompt,
        profile,
        synopsis: currentSynopsis,
        userRequest: event.prompt,
        archetype: active.archetype,
      });
      return {
        systemPrompt: compiled.systemPrompt,
        message: {
          customType: CONTEXT_MESSAGE,
          content: compiled.contextMessage ?? "",
          display: false,
          details: { taskId: active.taskId, profileId: active.promptProfileId },
        },
      };
    } finally {
      syncSafetyLifecycleTools(exposedSafetyLifecycle);
      ctx.ui.setWorkingMessage();
    }
  });

  pi.on("model_select", async (event, ctx) => {
    if (applyingSelection || event.source === "restore") return;
    if (state.active) state = { ...state, active: invalidateAuthorization(state.active, "manual model override") };
    state = markManualOverride(state);
    persistState();
    updateStatus(ctx);
    await record(
      ctx,
      "outcome",
      { manualOverride: "model", provider: event.model.provider, modelId: event.model.id },
      {
        provider: event.model.provider,
        modelId: event.model.id,
        ...(state.active
          ? {
              taskId: state.active.taskId,
              archetype: state.active.archetype,
              policyVersion: state.active.policyVersion,
              modelSnapshotId: state.active.modelSnapshotId,
            }
          : {}),
      },
    );
  });

  pi.on("thinking_level_select", async (event, ctx) => {
    if (applyingSelection) return;
    if (state.active) state = { ...state, active: invalidateAuthorization(state.active, "manual effort override") };
    const active = state.active;
    const changed = active ? changeEffortWithinLease(active, event.level, new Date().toISOString()) : undefined;
    if (changed?.success) state = { ...state, active: changed.lease };
    state = markManualOverride(state);
    persistState();
    updateStatus(ctx);
    await record(
      ctx,
      "outcome",
      {
        manualOverride: "effort",
        effort: event.level,
        leaseUpdated: changed?.success ?? false,
        ...(!changed?.success && changed ? { reason: changed.reason } : {}),
      },
      state.active
        ? {
            taskId: state.active.taskId,
            archetype: state.active.archetype,
            provider: state.active.selected.provider,
            modelId: state.active.selected.modelId,
            effort: event.level,
            promptProfileId: state.active.promptProfileId,
            policyVersion: state.active.policyVersion,
            modelSnapshotId: state.active.modelSnapshotId,
          }
        : {},
    );
  });

  pi.on("agent_start", () => {
    lastProviderFailure = undefined;
    attemptDisposition = "pending";
    agentRunSequence++;
    attemptStartedAt = Date.now();
    attemptTurns = 0;
    attemptToolCalls = 0;
    deterministicCheckCalls.clear();
    deterministicCheckResults.clear();
    potentiallyMutatingCalls.clear();
  });

  pi.on("turn_start", () => {
    attemptTurns++;
  });

  pi.on("tool_execution_end", (event) => {
    attemptToolCalls++;
    const check = deterministicCheckCalls.get(event.toolCallId);
    const mutation = potentiallyMutatingCalls.get(event.toolCallId);
    deterministicCheckCalls.delete(event.toolCallId);
    potentiallyMutatingCalls.delete(event.toolCallId);
    if (check) deterministicCheckResults.set(check, !event.isError);
    if (state.active && (check || (mutation && !event.isError))) {
      const now = new Date().toISOString();
      state = {
        ...state,
        active: {
          ...state.active,
          updatedAt: now,
          safetyEvidence: {
            ...state.active.safetyEvidence,
            checks: check
              ? [
                  ...state.active.safetyEvidence.checks.filter((entry) => entry.command !== check),
                  { command: check, passed: !event.isError, recordedAt: now },
                ].slice(-20)
              : state.active.safetyEvidence.checks,
            mutations:
              mutation && !event.isError
                ? [...state.active.safetyEvidence.mutations, { ...mutation, recordedAt: now }].slice(-50)
                : state.active.safetyEvidence.mutations,
          },
        },
      };
      persistState();
    }
  });

  pi.on("tool_call", (event) => {
    const reason = safetyToolBlockReason(state.active, event.toolName, event.input);
    if (reason) return { block: true, reason };
    if (event.toolName === "bash") {
      const command = deterministicCheckCommand(typeof event.input.command === "string" ? event.input.command : "");
      if (command) deterministicCheckCalls.set(event.toolCallId, command);
    }
    if (isPotentiallyMutatingTool(event.toolName, event.input)) {
      potentiallyMutatingCalls.set(event.toolCallId, {
        toolName: event.toolName,
        inputFingerprint: safetyFingerprint(event.input),
      });
    }
    return undefined;
  });

  pi.on("after_provider_response", (event) => {
    // An invalid/expired token is endpoint availability failure just like a rate
    // limit: move to the next authorized provider instead of failing the lease.
    if (event.status === 401 || event.status === 403 || event.status === 429 || event.status >= 500) {
      lastProviderFailure = "availability";
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    const active = state.active;
    if (!active || active.executionFailed) return;
    const assistants = event.messages.filter(assistantMessage);
    const isActiveAttempt =
      state.mode === "active" &&
      !state.manualOverride &&
      !active.manualOverride &&
      ctx.model?.provider === active.selected.provider &&
      ctx.model.id === active.selected.modelId;
    const relevant = isActiveAttempt
      ? assistants.filter(
          (message) => message.provider === active.selected.provider && message.model === active.selected.modelId,
        )
      : assistants;
    const cost = relevant.reduce((total, message) => total + message.usage.cost.total, 0);
    const last = relevant.at(-1);
    const attemptedProvider = last?.provider ?? active.selected.provider;
    const attemptedModel = last?.model ?? active.selected.modelId;
    const wallTimeMs = attemptStartedAt > 0 ? Date.now() - attemptStartedAt : 0;
    const accumulatedCost = (accumulatedTaskCosts.get(active.taskId) ?? 0) + (isActiveAttempt ? cost : 0);
    if (isActiveAttempt) accumulatedTaskCosts.set(active.taskId, accumulatedCost);
    const accumulatedStartedAt =
      taskStartedAt.get(active.taskId) ?? (attemptStartedAt > 0 ? attemptStartedAt : Date.now());
    const accumulatedWallTimeMs = Date.now() - accumulatedStartedAt;
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = aggregateAttemptTokenCounts(
      relevant.map((message) => message.usage),
    );
    lastAttemptMetrics = isActiveAttempt
      ? {
          provider: attemptedProvider,
          modelId: attemptedModel,
          archetype: active.archetype,
          modelAndToolCost: accumulatedCost,
          wallTimeMs: Math.max(wallTimeMs, accumulatedWallTimeMs),
          retried: active.attemptIndex > 0,
          cacheReadTokens,
          cacheWriteTokens,
        }
      : undefined;
    await record(
      ctx,
      "attempt_completed",
      {
        shadow: !isActiveAttempt,
        proposedProvider: active.selected.provider,
        proposedModelId: active.selected.modelId,
        cost,
        wallTimeMs,
        inputTokens,
        // Retain the pre-PR7 name while adding the exact provider usage field names.
        cachedInputTokens: cacheReadTokens,
        cacheReadTokens,
        cacheWriteTokens,
        cacheHitRatio: inputTokens > 0 ? cacheReadTokens / inputTokens : 0,
        outputTokens,
        turns: attemptTurns,
        toolCalls: attemptToolCalls,
        deterministicChecksPassed: [...deterministicCheckResults.values()].filter(Boolean).length,
        deterministicChecksFailed: [...deterministicCheckResults.values()].filter((passed) => !passed).length,
        stopReason: last?.stopReason,
      },
      {
        taskId: active.taskId,
        archetype: active.archetype,
        provider: attemptedProvider,
        modelId: attemptedModel,
        effort: isActiveAttempt ? active.selected.effort : pi.getThinkingLevel(),
        ...(isActiveAttempt ? { promptProfileId: active.promptProfileId } : {}),
        policyVersion: active.policyVersion,
        modelSnapshotId: active.modelSnapshotId,
      },
    );
    const deterministicVerificationFailed =
      isActiveAttempt && [...deterministicCheckResults.values()].some((passed) => !passed);
    const latestLifecycle = state.active?.taskId === active.taskId ? state.active.lifecycle : active.lifecycle;
    const safetyReviewMissing =
      isActiveAttempt && latestLifecycle.phase === "review" && latestLifecycle.submission === undefined;
    const planValidationMissing =
      isActiveAttempt &&
      (active.archetype === "implementation_planning" || active.archetype === "large_program_planning") &&
      !validatedPlanAttempts.has(`${active.taskId}:${String(active.attemptIndex)}:${String(agentRunSequence)}`);
    const planValidationRepairable =
      planValidationMissing &&
      !deterministicVerificationFailed &&
      last?.stopReason === "stop" &&
      active.planValidationRepairAttempted !== true;
    if (planValidationRepairable) {
      const repaired = {
        ...active,
        updatedAt: new Date().toISOString(),
        planValidationRepairAttempted: true,
      };
      state = installLease(state, repaired);
      attemptDisposition = "pending";
      persistState();
      updateStatus(ctx);
      await record(
        ctx,
        "outcome",
        { planValidationRepair: "requested", attemptIndex: active.attemptIndex },
        {
          taskId: active.taskId,
          archetype: active.archetype,
          provider: active.selected.provider,
          modelId: active.selected.modelId,
          effort: active.selected.effort,
          promptProfileId: active.promptProfileId,
          policyVersion: active.policyVersion,
          modelSnapshotId: active.modelSnapshotId,
        },
      );
      pi.sendMessage(
        {
          customType: CONTEXT_MESSAGE,
          content: [
            "The planning response did not call submit_implementation_plan.",
            "Continue the same attempt: submit the complete implementation-plan DAG with that tool, then return the concise validated-program summary.",
            "Do not broaden scope.",
          ].join("\n"),
          display: false,
          details: { taskId: active.taskId, repairReason: "missing_plan_validation" },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } else if (deterministicVerificationFailed || planValidationMissing || safetyReviewMissing) {
      attemptDisposition = "failed";
      await transitionFallback(ctx, "deterministic_verification", true);
    } else if (isActiveAttempt && (last?.stopReason === "error" || (!last && lastProviderFailure !== undefined))) {
      attemptDisposition = "failed";
      const failure = lastProviderFailure ?? "model_error";
      lastProviderFailure = undefined;
      await transitionFallback(ctx, failure, true);
    } else if (isActiveAttempt && last?.stopReason === "length") {
      attemptDisposition = "failed";
      await transitionFallback(ctx, "quality", true);
    } else if (isActiveAttempt && last?.stopReason === "stop") {
      attemptDisposition = "success";
    } else if (isActiveAttempt && last?.stopReason === "aborted") {
      attemptDisposition = "aborted";
    } else {
      attemptDisposition = "incomplete";
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const active = state.active;
    if (!active || state.mode !== "active" || active.executionFailed) return;
    if (active.lifecycle.phase === "review") {
      if (attemptDisposition === "success" && active.lifecycle.submission) {
        await restoreParentAfterReview(ctx, active, "completed");
      } else if (attemptDisposition === "aborted") {
        await restoreParentAfterReview(ctx, active, "skipped");
      }
      return;
    }
    if (attemptDisposition !== "success" && attemptDisposition !== "unknown") return;

    if (active.lifecycle.phase === "preflight") {
      const plan = active.lifecycle.plan;
      if (plan) {
        const scopeFingerprint = safetyFingerprint({
          taskFingerprint: active.lifecycle.taskFingerprint,
          planFingerprint: plan.planFingerprint,
        });
        await startIndependentReview(
          ctx,
          active,
          "authorization",
          scopeFingerprint,
          [
            `Review the validated plan ${plan.planFingerprint} for task ${plan.taskFingerprint}.`,
            `Targets: ${plan.plan.targets.join(", ")}.`,
            "Verify concrete preconditions, irreversible effects, rollback realism, abort conditions, tool scope, and task/plan alignment. Approval applies only to this exact fingerprint.",
          ].join("\n"),
        );
      } else if (!active.lifecycle.evidenceRepairAttempted) {
        const repaired = {
          ...active,
          updatedAt: new Date().toISOString(),
          lifecycle: { ...active.lifecycle, evidenceRepairAttempted: true },
        };
        state = installLease(state, repaired);
        persistState();
        pi.sendMessage(
          {
            customType: CONTEXT_MESSAGE,
            content:
              "Preflight is still non-mutating. Inspect the exact targets and call submit_action_plan with concrete steps, preconditions, verification, rollback, abort conditions, irreversible effects, and required tool names.",
            display: true,
            details: { taskId: active.taskId, repairReason: "missing_action_plan" },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } else {
        ctx.ui.notify("Irreversible action remains blocked: no validated action plan is available", "error");
      }
      return;
    }

    if (active.lifecycle.phase === "advisory_pending") {
      await startIndependentReview(
        ctx,
        active,
        "advisory",
        safetyFingerprint({ taskFingerprint: active.lifecycle.taskFingerprint, features: active.features }),
        "Assess the high-risk reversible action before execution. Identify failure modes, safer sequencing, checks, and stop conditions. This is advice, not authorization.",
      );
      return;
    }

    if (lifecycleRequiresCompletionReview(active.lifecycle)) {
      const collected = await collectCompletionEvidence(ctx, active);
      if (collected.evidence) {
        const codeBuilder = isCodeBuilder(active.features);
        await startIndependentReview(
          ctx,
          active,
          "completion",
          collected.evidence.evidenceFingerprint,
          codeBuilder
            ? [
                `Review implementation evidence ${collected.evidence.evidenceFingerprint}.`,
                `Baseline HEAD: ${collected.evidence.baselineHead ?? "unavailable"}; completed HEAD: ${collected.evidence.completedHead ?? "unavailable"}.`,
                `Changed files: ${collected.evidence.changedFiles.join(", ") || "committed delta"}.`,
                `Deterministic checks: ${collected.evidence.checks.map((check) => `${check.passed ? "PASS" : "FAIL"} ${check.command}`).join("; ")}.`,
                "Inspect working-tree, staged, and baseline-to-HEAD changes; the fingerprints are scope bindings, not a substitute for reading the diff and test evidence.",
              ].join("\n")
            : [
                `Review completion evidence ${collected.evidence.evidenceFingerprint} for the tracked high-risk operation.`,
                `Recorded successful mutating tools: ${collected.evidence.mutations.map((mutation) => mutation.toolName).join(", ")}.`,
                "Check observed outcomes against the original task, advisory/authorization constraints, and available verification evidence.",
              ].join("\n"),
        );
      } else if (!("evidenceRepairAttempted" in active.lifecycle) || !active.lifecycle.evidenceRepairAttempted) {
        const repaired = {
          ...active,
          updatedAt: new Date().toISOString(),
          lifecycle: { ...active.lifecycle, evidenceRepairAttempted: true },
        } as TaskLease;
        state = installLease(state, repaired);
        persistState();
        pi.sendMessage(
          {
            customType: CONTEXT_MESSAGE,
            content: `Required completion review has not started: ${collected.reason ?? "validated evidence is missing"}. Produce the missing deterministic diff/test or operation evidence without broadening scope.`,
            display: true,
            details: { taskId: active.taskId, repairReason: "missing_completion_evidence" },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      } else {
        ctx.ui.notify(`Required completion review is blocked: ${collected.reason ?? "evidence missing"}`, "error");
      }
    }
  });

  pi.registerCommand("route", {
    description: "Show model-router mode or scope diagnostics; record outcomes or trigger deterministic fallback",
    handler: async (args, ctx) => {
      const [command, value] = args.trim().split(/\s+/, 2);
      if (command === "active" || command === "shadow" || command === "off") {
        if (command === "active" && !telemetryHealthy) {
          ctx.ui.notify(
            "Router cannot enter active mode after a telemetry failure; reload after fixing the path",
            "error",
          );
          return;
        }
        state = {
          ...state,
          mode: command,
          ...(command === "active"
            ? {
                manualOverride: false,
                ...(state.active ? { active: { ...state.active, manualOverride: false } } : {}),
              }
            : {}),
        };
        if (command === "active" && state.active) {
          accumulatedTaskCosts.set(state.active.taskId, 0);
          taskStartedAt.set(state.active.taskId, Date.now());
        }
        persistState();
        updateStatus(ctx);
        // Recorded immediately so `startMode: "last"` survives a crash, not just a clean exit.
        await rememberMode(state.mode);
        ctx.ui.notify(`Model router mode set to ${command}`, "info");
        return;
      }
      if (command === "scope") {
        const registry = buildRegistrySnapshot(ctx, scope);
        const diagnostics = buildScopeDiagnostics({
          patterns: scope.patterns,
          patternSource: scope.patternSource,
          registry,
          allRegistryEndpoints: ctx.modelRegistry
            .getAll()
            .map((model) => ({ provider: model.provider, modelId: model.id })),
          providerWeightRejections: scope.providerWeightRejections,
          ...(lastRoute.decision ? { latestRouteExclusions: lastRoute.decision.exclusions } : {}),
        });
        ctx.ui.notify(renderScopeDiagnostics(diagnostics), "info");
        return;
      }
      if (command === "reset") {
        state = setHardBoundary({ mode: state.mode, manualOverride: false }, "new_session");
        persistState();
        updateStatus(ctx);
        ctx.ui.notify("Router lease cleared; next user input is a new task", "info");
        return;
      }
      if (command === "accept" || command === "reject") {
        if (!lastAttemptMetrics || !state.active) {
          ctx.ui.notify("No completed routed attempt is available to label", "warning");
          return;
        }
        await record(
          ctx,
          "outcome",
          {
            ...lastAttemptMetrics,
            accepted: command === "accept",
            humanIntervention: command === "reject",
            contextBucket: state.active.contextSizeBucket ?? state.active.features.contextShape,
            risk: state.active.features.risk,
            interactivity: state.active.features.interactivity,
            languageBucket: state.active.repositoryLanguageBucket ?? "unknown",
          },
          {
            taskId: state.active.taskId,
            archetype: state.active.archetype,
            provider: lastAttemptMetrics.provider,
            modelId: lastAttemptMetrics.modelId,
          },
        );
        ctx.ui.notify(`Recorded routed attempt as ${command === "accept" ? "accepted" : "rejected"}`, "info");
        return;
      }
      if (
        command === "fail" &&
        (value === "availability" || value === "quality" || value === "deterministic_verification")
      ) {
        await transitionFallback(ctx, value, true);
        return;
      }
      const lease = state.active;
      const detail = lease
        ? [
            `mode=${state.mode}`,
            `task=${lease.taskId}`,
            `route=${lease.archetype}`,
            `model=${lease.selected.provider}/${lease.selected.modelId}`,
            `effort=${lease.selected.effort}`,
            `profile=${lease.promptProfileId}`,
            `safety=${lease.lifecycle.policy}/${lease.lifecycle.phase}`,
            `attempt=${String(lease.attemptIndex + 1)}/${String(lease.fallbacks.length + 1)}`,
            `execution=${lease.executionFailed ? "failed" : "ready"}`,
            `boundary=${lastRoute.boundaryReason ?? "n/a"}`,
          ].join("\n")
        : `mode=${state.mode}\nNo active task lease`;
      ctx.ui.notify(detail, "info");
    },
  });
}
