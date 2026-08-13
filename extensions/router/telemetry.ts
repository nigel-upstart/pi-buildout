import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ClassifierAttempt, ClassifierAttemptObservation } from "./classifier.ts";
import type { Archetype } from "./core/archetype.ts";
import { calculateEndpointEffectiveCost, classifyCacheWriteRate } from "./core/endpoint-cost.ts";
import type { CacheWriteClassification } from "./core/endpoint-cost.ts";
import type { TaskFeatures } from "./core/features.ts";
import type { ProviderWeightBasis, ResolvedProviderWeight } from "./core/provider-weights.ts";
import type { RouteSample } from "./core/routing.ts";

type TelemetryEventKind =
  | "boundary"
  | "classifier_invocation"
  | "classifier_attempt"
  | "route_decision"
  | "attempt_completed"
  | "fallback"
  | "outcome";

export type RouterTelemetryEvent = {
  version: 1;
  eventId: string;
  timestamp: string;
  kind: TelemetryEventKind;
  sessionId: string;
  taskId?: string;
  routeKey?: string;
  archetype?: Archetype;
  provider?: string;
  modelId?: string;
  effort?: string;
  promptProfileId?: string;
  policyVersion?: string;
  modelSnapshotId?: string;
  /** Endpoint ordering diagnostics captured at event time; absent on pre-PR7 and non-endpoint records. */
  endpointEffectiveCost?: number;
  appliedProviderWeight?: number;
  providerWeightBasis?: ProviderWeightBasis;
  cacheWriteClassification?: CacheWriteClassification;
  data: Record<string, unknown>;
};

export type ClassifierInvocationPurpose = "continuity" | "fresh_task";
type ClassifierInvocationOutcome = "success" | "timeout" | "error";
type ClassifierInvocationResolution = "classified" | "failed_closed" | "retained_continuity" | "new_task" | "none";
type ClassifierAttemptOutcome = "valid" | "invalid" | "error" | "cancelled" | "incomplete";

type ClassifierInvocationAttempt = {
  stage: "primary" | "secondary";
  try: number;
  outcome: ClassifierAttemptOutcome;
  provider?: string;
  modelId?: string;
  latencyMs?: number;
};

type ClassifierInvocationStage = {
  stage: "primary" | "secondary";
  attemptCount: number;
  completedAttemptCount: number;
  validAttemptCount: number;
};

/**
 * Exactly one summary is emitted per router-level classification request, whether it succeeds,
 * times out, is cancelled, or fails unexpectedly. `classifier_attempt` remains a legacy lower-level
 * diagnostic record for an individual completed schema/transport attempt. Consumers count only
 * `classifier_invocation` for request rates and must never add the two event kinds together.
 */
export type ClassifierInvocationSummary = {
  purpose: ClassifierInvocationPurpose;
  outcome: ClassifierInvocationOutcome;
  resolution: ClassifierInvocationResolution;
  /** Total router-observed wall latency, including retries and secondary classification. */
  wallLatencyMs: number;
  timedOut: boolean;
  cancelled: boolean;
  failedClosed?: boolean;
  attemptCount: number;
  completedAttemptCount: number;
  validAttemptCount: number;
  stages: ClassifierInvocationStage[];
  attempts: ClassifierInvocationAttempt[];
  errorCategory?: "deadline" | "transport_timeout" | "cancelled" | "unexpected";
};

export type ClassifierInvocationRun<T> =
  | { status: "completed"; value: T; summary: ClassifierInvocationSummary }
  | { status: "failed"; error?: unknown; summary: ClassifierInvocationSummary };

type TrackedClassifierAttempt = {
  stage: "primary" | "secondary";
  try: number;
  outcome?: Exclude<ClassifierAttemptOutcome, "incomplete">;
  provider?: string;
  modelId?: string;
  latencyMs?: number;
};

function telemetryIdentifier(value: string | undefined): string | undefined {
  if (!value || value.length > 200 || !/^[a-zA-Z0-9._:/-]+$/.test(value)) return undefined;
  return value;
}

function finiteNonnegative(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function classifierInvocationSummary(
  purpose: ClassifierInvocationPurpose,
  outcome: ClassifierInvocationOutcome,
  wallLatencyMs: number,
  timedOut: boolean,
  cancelled: boolean,
  tracked: ReadonlyMap<string, TrackedClassifierAttempt>,
  errorCategory?: ClassifierInvocationSummary["errorCategory"],
): ClassifierInvocationSummary {
  const attempts = [...tracked.values()].map<ClassifierInvocationAttempt>((attempt) => {
    const provider = telemetryIdentifier(attempt.provider);
    const modelId = telemetryIdentifier(attempt.modelId);
    const latencyMs = finiteNonnegative(attempt.latencyMs);
    return {
      stage: attempt.stage,
      try: attempt.try,
      outcome: attempt.outcome ?? "incomplete",
      ...(provider ? { provider } : {}),
      ...(modelId ? { modelId } : {}),
      ...(latencyMs === undefined ? {} : { latencyMs }),
    };
  });
  const stages = (["primary", "secondary"] as const)
    .map<ClassifierInvocationStage>((stage) => {
      const stageAttempts = attempts.filter((attempt) => attempt.stage === stage);
      return {
        stage,
        attemptCount: stageAttempts.length,
        completedAttemptCount: stageAttempts.filter((attempt) => attempt.outcome !== "incomplete").length,
        validAttemptCount: stageAttempts.filter((attempt) => attempt.outcome === "valid").length,
      };
    })
    .filter((stage) => stage.attemptCount > 0);
  return {
    purpose,
    outcome,
    resolution: "none",
    wallLatencyMs,
    timedOut,
    cancelled,
    attemptCount: attempts.length,
    completedAttemptCount: attempts.filter((attempt) => attempt.outcome !== "incomplete").length,
    validAttemptCount: attempts.filter((attempt) => attempt.outcome === "valid").length,
    stages,
    attempts,
    ...(errorCategory ? { errorCategory } : {}),
  };
}

/** Runs and measures one classifier invocation without ever persisting its prompt, synopsis, or errors. */
export async function runClassifierInvocation<T>(input: {
  purpose: ClassifierInvocationPurpose;
  timeoutMs: number;
  invoke: (signal: AbortSignal, onAttempt: (observation: ClassifierAttemptObservation) => void) => Promise<T>;
}): Promise<ClassifierInvocationRun<T>> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const tracked = new Map<string, TrackedClassifierAttempt>();
  const observe = (observation: ClassifierAttemptObservation): void => {
    const key = `${observation.stage}:${String(observation.try)}`;
    const existing = tracked.get(key) ?? { stage: observation.stage, try: observation.try };
    if (observation.state === "completed") {
      const provider = telemetryIdentifier(observation.provider);
      const modelId = telemetryIdentifier(observation.modelId);
      const latencyMs = finiteNonnegative(observation.latencyMs);
      tracked.set(key, {
        ...existing,
        outcome: observation.outcome,
        ...(provider ? { provider } : {}),
        ...(modelId ? { modelId } : {}),
        ...(latencyMs === undefined ? {} : { latencyMs }),
      });
    } else {
      tracked.set(key, existing);
    }
  };

  type Settled = { kind: "success"; value: T } | { kind: "error"; error: unknown } | { kind: "deadline" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Settled>((resolve) => {
    timer = setTimeout(
      () => {
        controller.abort();
        resolve({ kind: "deadline" });
      },
      Math.max(0, input.timeoutMs),
    );
  });
  const operation: Promise<Settled> = Promise.resolve()
    .then(() => input.invoke(controller.signal, observe))
    .then<Settled, Settled>(
      (value) => ({ kind: "success", value }),
      (error: unknown) => ({ kind: "error", error }),
    );
  const settled = await Promise.race([operation, deadline]);
  if (timer) clearTimeout(timer);
  const wallLatencyMs = Math.max(0, Math.round(performance.now() - startedAt));

  if (settled.kind === "success") {
    return {
      status: "completed",
      value: settled.value,
      summary: classifierInvocationSummary(input.purpose, "success", wallLatencyMs, false, false, tracked),
    };
  }
  if (settled.kind === "deadline") {
    return {
      status: "failed",
      summary: classifierInvocationSummary(input.purpose, "timeout", wallLatencyMs, true, true, tracked, "deadline"),
    };
  }

  const name = settled.error instanceof Error ? settled.error.name : undefined;
  const timedOut = name === "TimeoutError";
  const cancelled = name === "AbortError" || controller.signal.aborted;
  return {
    status: "failed",
    error: settled.error,
    summary: classifierInvocationSummary(
      input.purpose,
      timedOut ? "timeout" : "error",
      wallLatencyMs,
      timedOut,
      cancelled,
      tracked,
      timedOut ? "transport_timeout" : cancelled ? "cancelled" : "unexpected",
    ),
  };
}

/** Finalizes the safe router-level outcome after continuity resolution or failed-close handling. */
export function completeClassifierInvocation(
  summary: ClassifierInvocationSummary,
  resolution: "classified" | "retained_continuity" | "new_task",
  failedClosed: boolean,
): ClassifierInvocationSummary {
  if (summary.outcome !== "success") return summary;
  return {
    ...summary,
    resolution: resolution === "classified" && failedClosed ? "failed_closed" : resolution,
    failedClosed,
  };
}

export type SanitizedClassifierAttempt = Omit<ClassifierAttempt, "provider" | "modelId"> & {
  provider?: string;
  modelId?: string;
  errorCount: number;
};

/** Removes free-form errors while retaining the legacy empty `errors` array and adding a count. */
export function sanitizeClassifierAttempt(attempt: ClassifierAttempt): SanitizedClassifierAttempt {
  const { errors, provider: rawProvider, modelId: rawModelId, ...safe } = attempt;
  const provider = telemetryIdentifier(rawProvider);
  const modelId = telemetryIdentifier(rawModelId);
  return {
    ...safe,
    ...(provider ? { provider } : {}),
    ...(modelId ? { modelId } : {}),
    errors: [],
    errorCount: errors.length,
  };
}

/**
 * Evidence is classifier-authored free text and must not be persisted. Preserve the legacy
 * `TaskFeatures` contract (including its non-empty evidence array) with one fixed marker per item;
 * consumers can still infer the count without receiving classifier-authored content.
 */
export function sanitizeClassifierFeatures(features: TaskFeatures): TaskFeatures {
  return { ...features, evidence: features.evidence.map(() => "[redacted]") };
}

export type ClassifierSpanLike = {
  setAttribute(name: string, value: string | number | boolean): unknown;
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): unknown;
};

function safelyAnnotate(operation: () => unknown): void {
  try {
    operation();
  } catch {
    // Optional telemetry can never alter classification or routing.
  }
}

/** Adds bounded invocation metrics and attempt events to an already-optional router classifier span. */
export function annotateClassifierSpan(
  span: ClassifierSpanLike | undefined,
  summary: ClassifierInvocationSummary,
): void {
  if (!span) return;
  const attributes: Record<string, string | number | boolean> = {
    "router.classifier.purpose": summary.purpose,
    "router.classifier.outcome": summary.outcome,
    "router.classifier.resolution": summary.resolution,
    "router.classifier.latency_ms": summary.wallLatencyMs,
    "router.classifier.timed_out": summary.timedOut,
    "router.classifier.cancelled": summary.cancelled,
    "router.classifier.attempt_count": summary.attemptCount,
    "router.classifier.completed_attempt_count": summary.completedAttemptCount,
    "router.classifier.valid_attempt_count": summary.validAttemptCount,
    ...(summary.failedClosed === undefined ? {} : { "router.classifier.failed_closed": summary.failedClosed }),
    ...(summary.errorCategory ? { "router.classifier.error_category": summary.errorCategory } : {}),
  };
  for (const stage of summary.stages) {
    attributes[`router.classifier.${stage.stage}.attempt_count`] = stage.attemptCount;
    attributes[`router.classifier.${stage.stage}.completed_attempt_count`] = stage.completedAttemptCount;
    attributes[`router.classifier.${stage.stage}.valid_attempt_count`] = stage.validAttemptCount;
  }
  for (const [name, value] of Object.entries(attributes)) {
    safelyAnnotate(() => span.setAttribute(name, value));
  }
  for (const attempt of summary.attempts) {
    safelyAnnotate(() =>
      span.addEvent("router.classifier.attempt", {
        stage: attempt.stage,
        try: attempt.try,
        outcome: attempt.outcome,
        ...(attempt.provider ? { provider: attempt.provider } : {}),
        ...(attempt.modelId ? { modelId: attempt.modelId } : {}),
        ...(attempt.latencyMs === undefined ? {} : { latency_ms: attempt.latencyMs }),
      }),
    );
  }
  safelyAnnotate(() => span.addEvent("router.classifier.completed", attributes));
}

export type AttemptOutcome = {
  provider: string;
  modelId: string;
  archetype: Archetype;
  contextBucket?: string;
  risk?: string;
  interactivity?: string;
  languageBucket?: string;
  accepted: boolean;
  modelAndToolCost: number;
  wallTimeMs: number;
  humanIntervention: boolean;
  retried: boolean;
  /** Optional so labeled outcomes written before PR7 remain valid samples. */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

export type AttemptTokenCounts = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

function observedTokenCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Sums provider-reported usage for one exact endpoint attempt. */
export function aggregateAttemptTokenCounts(
  usages: readonly {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite?: number;
  }[],
): AttemptTokenCounts {
  return usages.reduce<AttemptTokenCounts>(
    (total, usage) => ({
      inputTokens: total.inputTokens + observedTokenCount(usage.input),
      outputTokens: total.outputTokens + observedTokenCount(usage.output),
      cacheReadTokens: total.cacheReadTokens + observedTokenCount(usage.cacheRead),
      cacheWriteTokens: total.cacheWriteTokens + observedTokenCount(usage.cacheWrite),
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );
}

function optionalFiniteNonnegative(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isRouterTelemetryEvent(value: unknown): value is RouterTelemetryEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.kind === "string" &&
    typeof candidate.sessionId === "string" &&
    optionalFiniteNonnegative(candidate.endpointEffectiveCost) &&
    optionalFiniteNonnegative(candidate.appliedProviderWeight) &&
    (candidate.providerWeightBasis === undefined ||
      candidate.providerWeightBasis === "contract" ||
      candidate.providerWeightBasis === "preference") &&
    (candidate.cacheWriteClassification === undefined ||
      candidate.cacheWriteClassification === "priced_write" ||
      candidate.cacheWriteClassification === "no_write_line_item" ||
      candidate.cacheWriteClassification === "caching_unpriced") &&
    candidate.data !== null &&
    typeof candidate.data === "object" &&
    !Array.isArray(candidate.data)
  );
}

export type EndpointTelemetryFields = Pick<
  RouterTelemetryEvent,
  "endpointEffectiveCost" | "appliedProviderWeight" | "providerWeightBasis" | "cacheWriteClassification"
>;

/**
 * Captures the exact inputs behind endpoint ordering without making telemetry a routing dependency.
 * Malformed diagnostic prices are omitted rather than throwing after route selection has completed.
 */
export function endpointTelemetryFields(
  endpoint: {
    provider: string;
    costPerMillion: { input: number; output: number; cacheRead: number; cacheWrite: number };
  },
  providerWeight: ResolvedProviderWeight,
): EndpointTelemetryFields {
  const fields: EndpointTelemetryFields = {};
  try {
    fields.cacheWriteClassification = classifyCacheWriteRate(endpoint.costPerMillion);
  } catch {
    // Route selection records its own pricing exclusion; diagnostics must not degrade routing.
  }
  try {
    const endpointEffectiveCost = calculateEndpointEffectiveCost(endpoint, providerWeight.weight);
    if (endpointEffectiveCost !== undefined) {
      fields.endpointEffectiveCost = endpointEffectiveCost;
      fields.appliedProviderWeight = providerWeight.weight;
      fields.providerWeightBasis = providerWeight.basis;
    }
  } catch {
    // See above. Older or malformed registries still retain the base append-only event.
  }
  return fields;
}

/** Extracts valid labeled outcomes while preserving optional fields on pre-PR7 records. */
export function attemptOutcomesFromTelemetry(events: readonly RouterTelemetryEvent[]): AttemptOutcome[] {
  const outcomes: AttemptOutcome[] = [];
  for (const event of events) {
    if (event.kind !== "outcome") continue;
    const data = event.data;
    if (
      typeof data.provider !== "string" ||
      typeof data.modelId !== "string" ||
      typeof data.archetype !== "string" ||
      typeof data.accepted !== "boolean" ||
      typeof data.modelAndToolCost !== "number" ||
      typeof data.wallTimeMs !== "number" ||
      typeof data.humanIntervention !== "boolean" ||
      typeof data.retried !== "boolean" ||
      // Validated the same way the event schema validates them, so a persisted NaN, Infinity, or
      // negative count cannot reach the token aggregates through this path.
      !optionalFiniteNonnegative(data.cacheReadTokens) ||
      !optionalFiniteNonnegative(data.cacheWriteTokens)
    ) {
      continue;
    }
    outcomes.push(data as unknown as AttemptOutcome);
  }
  return outcomes;
}

export class JsonlTelemetryStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async append(event: RouterTelemetryEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async read(limit = 10_000): Promise<RouterTelemetryEvent[]> {
    let content: string;
    try {
      content = await readFile(this.path, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const lines = content.trim().split("\n").filter(Boolean).slice(-Math.max(0, limit));
    const events: RouterTelemetryEvent[] = [];
    for (const line of lines) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (isRouterTelemetryEvent(parsed)) events.push(parsed);
      } catch {
        // Ignore a torn final append while retaining every complete event before it.
      }
    }
    return events;
  }
}

export function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function aggregateRouteSamples(outcomes: readonly AttemptOutcome[]): RouteSample[] {
  const groups = new Map<string, AttemptOutcome[]>();
  for (const outcome of outcomes) {
    const key = [
      outcome.provider,
      outcome.modelId,
      outcome.archetype,
      outcome.contextBucket ?? "unknown-context",
      outcome.risk ?? "unknown-risk",
      outcome.interactivity ?? "unknown-interactivity",
      outcome.languageBucket ?? "unknown-language",
    ].join("/");
    groups.set(key, [...(groups.get(key) ?? []), outcome]);
  }
  return [...groups.values()].map((samples) => {
    const first = samples[0];
    if (!first) throw new Error("route sample group unexpectedly empty");
    const ratio = (predicate: (sample: AttemptOutcome) => boolean) =>
      samples.filter(predicate).length / Math.max(1, samples.length);
    return {
      provider: first.provider,
      modelId: first.modelId,
      archetype: first.archetype,
      ...(first.contextBucket ? { contextBucket: first.contextBucket } : {}),
      ...(first.risk ? { risk: first.risk } : {}),
      ...(first.interactivity ? { interactivity: first.interactivity } : {}),
      ...(first.languageBucket ? { languageBucket: first.languageBucket } : {}),
      comparableSamples: samples.length,
      acceptedRate: ratio((sample) => sample.accepted),
      p50ModelAndToolCost: percentile(
        samples.map((sample) => sample.modelAndToolCost),
        0.5,
      ),
      p75ModelAndToolCost: percentile(
        samples.map((sample) => sample.modelAndToolCost),
        0.75,
      ),
      p90ModelAndToolCost: percentile(
        samples.map((sample) => sample.modelAndToolCost),
        0.9,
      ),
      p50WallTimeMs: percentile(
        samples.map((sample) => sample.wallTimeMs),
        0.5,
      ),
      p75WallTimeMs: percentile(
        samples.map((sample) => sample.wallTimeMs),
        0.75,
      ),
      p90WallTimeMs: percentile(
        samples.map((sample) => sample.wallTimeMs),
        0.9,
      ),
      probabilityHumanIntervention: ratio((sample) => sample.humanIntervention),
      probabilityRetry: ratio((sample) => sample.retried),
    };
  });
}

type SpanContextLike = {
  traceId: string;
  spanId: string;
  traceFlags?: number;
  isRemote?: boolean;
};

type SpanLike = {
  setAttribute(name: string, value: string | number | boolean): SpanLike;
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): SpanLike;
  recordException(error: unknown): void;
  setStatus(status: { code: number; message?: string }): SpanLike;
  end(): void;
};

type TracerLike = {
  startSpan(
    name: string,
    options?: { attributes?: Record<string, string | number | boolean> },
    context?: unknown,
  ): SpanLike;
};

type RuntimeRegistryValue = {
  tracer: TracerLike;
};

const RUNTIME_REGISTRY = Symbol.for("pi.telemetry-otel.runtimeRegistry.v1");
const ACTIVE_CONTEXT_REGISTRY = Symbol.for("pi.telemetry-otel.activeSpanContextRegistry.v1");
const OTEL_API = Symbol.for("opentelemetry.js.api.1");
const OTEL_SPAN_KEY = Symbol.for("OpenTelemetry Context Key SPAN");

function symbolMap<T>(symbol: symbol): Map<string, T> | undefined {
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const value = globals[symbol];
  return value instanceof Map ? (value as Map<string, T>) : undefined;
}

function parentContext(sessionId: string): unknown {
  const activeSpanContext = symbolMap<SpanContextLike>(ACTIVE_CONTEXT_REGISTRY)?.get(sessionId);
  if (!activeSpanContext) return undefined;
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const api = globals[OTEL_API] as
    { context?: { active?: () => { setValue?: (key: symbol, value: unknown) => unknown } } } | undefined;
  const active = api?.context?.active?.();
  if (!active?.setValue) return undefined;
  const nonRecordingSpan = {
    spanContext: () => activeSpanContext,
    setAttribute() {
      return this;
    },
    setAttributes() {
      return this;
    },
    addEvent() {
      return this;
    },
    addLink() {
      return this;
    },
    addLinks() {
      return this;
    },
    setStatus() {
      return this;
    },
    updateName() {
      return this;
    },
    end() {
      return undefined;
    },
    isRecording: () => false,
    recordException() {
      return undefined;
    },
  };
  return active.setValue(OTEL_SPAN_KEY, nonRecordingSpan);
}

export async function withRouterSpan<T>(
  sessionId: string,
  name: string,
  attributes: Record<string, string | number | boolean>,
  operation: (span: SpanLike | undefined) => Promise<T> | T,
): Promise<T> {
  const runtime = symbolMap<RuntimeRegistryValue>(RUNTIME_REGISTRY)?.get(sessionId);
  const span = runtime?.tracer.startSpan(name, { attributes }, parentContext(sessionId));
  try {
    return await operation(span);
  } catch (error) {
    span?.recordException(error);
    span?.setStatus({ code: 2, message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    span?.end();
  }
}
