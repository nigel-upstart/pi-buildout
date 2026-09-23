/**
 * Modified from upstream pi-otel 0.3.0: meters come from the scoped provider
 * and include a custom provider-reported USD cost counter.
 *
 * GenAI client histograms — sigil-aligned per OTel semconv. Lazy so this
 * module is safe to import when metrics are disabled (a no-op meter is used
 * until a Pi-owned MeterProvider is configured).
 */

import {
  type Counter,
  createNoopMeter,
  type Histogram,
  type MeterProvider,
  type MetricOptions,
} from "@opentelemetry/api";

const METER_NAME = "pi-otel";
const METER_VERSION = "0.1.0";

const cache = new Map<string, Histogram | Counter>();
let meterProvider: MeterProvider | null = null;

export function configureMeterProvider(provider: MeterProvider | null): void {
  meterProvider = provider;
  cache.clear();
}

// Without a Pi-owned provider (metrics disabled or SDK not initialized) use a
// no-op meter rather than the global provider, so a disabled signal can never
// emit through a foreign SDK.
function getMeter() {
  return meterProvider?.getMeter(METER_NAME, METER_VERSION) ?? createNoopMeter();
}

function getHistogram(name: string, opts: MetricOptions): Histogram {
  let h = cache.get(name) as Histogram | undefined;
  if (!h) {
    h = getMeter().createHistogram(name, opts);
    cache.set(name, h);
  }
  return h;
}

function getCounter(name: string, opts: MetricOptions): Counter {
  let c = cache.get(name) as Counter | undefined;
  if (!c) {
    c = getMeter().createCounter(name, opts);
    cache.set(name, c);
  }
  return c;
}

export const getDurationHistogram = () =>
  getHistogram("gen_ai.client.operation.duration", {
    description: "Duration of GenAI client operations",
    unit: "s",
  });

export const getTokenHistogram = () =>
  getHistogram("gen_ai.client.token.usage", {
    description: "Number of tokens used in GenAI client operations",
    unit: "{token}",
  });

/** Custom metric: the GenAI semconv does not define monetary cost. */
export const getCostCounter = () =>
  getCounter("gen_ai.client.cost.usd", {
    description: "Provider-reported cost of GenAI client operations in USD",
    unit: "USD",
  });

// Step-1 integer buckets up to 32. Default OTel boundaries start at 5, so
// per-op counts of 0/1/2 all land in the first bucket and percentile readers
// (e.g. Aspire) report the bucket upper bound instead of the actual value.
const TOOL_CALL_BUCKETS = Array.from({ length: 33 }, (_, i) => i);

export const getToolCallsHistogram = () =>
  getHistogram("gen_ai.client.tool_calls_per_operation", {
    description: "Number of tool calls per GenAI client operation",
    unit: "{call}",
    advice: { explicitBucketBoundaries: TOOL_CALL_BUCKETS },
  });

export const getToolCallsCounter = () =>
  getCounter("gen_ai.client.tool.calls", {
    description: "Total number of tool calls invoked by the agent",
    unit: "{call}",
  });

export function resetMetricHandles(): void {
  configureMeterProvider(null);
}
