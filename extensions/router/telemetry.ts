import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Archetype } from "./core/archetype.ts";
import { calculateEndpointEffectiveCost, classifyCacheWriteRate } from "./core/endpoint-cost.ts";
import type { CacheWriteClassification } from "./core/endpoint-cost.ts";
import type { ProviderWeightBasis, ResolvedProviderWeight } from "./core/provider-weights.ts";
import type { RouteSample } from "./core/routing.ts";

type TelemetryEventKind =
  "boundary" | "classifier_attempt" | "route_decision" | "attempt_completed" | "fallback" | "outcome";

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
      (data.cacheReadTokens !== undefined && typeof data.cacheReadTokens !== "number") ||
      (data.cacheWriteTokens !== undefined && typeof data.cacheWriteTokens !== "number")
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
