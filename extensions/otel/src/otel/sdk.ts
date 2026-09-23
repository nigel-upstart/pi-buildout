/**
 * Modified from upstream pi-otel 0.3.0: migrated to the OpenTelemetry 2.x /
 * 0.2xx SDK train, replaced global registration with provider-scoped signal
 * pipelines, split process identity out of metric resources, and added export
 * delivery health.
 *
 * OTel SDK bootstrap. Pi owns provider-scoped signal pipelines so it can
 * coexist with instrumentation that already registered global providers.
 */

import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import {
  context as otelContext,
  diag,
  type Tracer,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPLogExporter as LogGrpcExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPLogExporter as LogHttpExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPLogExporter as LogProtoExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter as MetricGrpcExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPMetricExporter as MetricHttpExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPMetricExporter as MetricProtoExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter as GrpcExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPTraceExporter as HttpExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPTraceExporter as ProtoExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  defaultResource,
  detectResources,
  envDetector,
  hostDetector,
  processDetector,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from "@opentelemetry/sdk-logs";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  AlwaysOffSampler,
  BasicTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_SERVICE_INSTANCE_ID,
  ATTR_SERVICE_NAME,
} from "@opentelemetry/semantic-conventions/incubating";
import { ATTR_PI_CWD } from "../attrs.js";
import type { OtelConfig } from "../config.js";
import {
  configureExportHealth,
  instrumentExporter,
  resetExportHealth,
} from "./health.js";
import {
  buildBridgeDiagLogger,
  configureLoggerProvider,
  resetLogHandles,
} from "./logs.js";
import {
  configureMeterProvider,
  resetMetricHandles,
} from "./metrics.js";

export type NotifySeverity = "info" | "warning" | "error";
export type Notify = (msg: string, severity?: NotifySeverity) => void;

export interface OtelRuntime {
  tracer: Tracer;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

let sdk: OtelRuntime | null = null;
let initOnce = false;
let foreignNoticeSent = false;
let ownedContextManager: AsyncLocalStorageContextManager | null = null;
let ownsDiagLogger = false;

// @opentelemetry/api and api-logs keep their global provider registry on
// these Symbol.for keys, shared across module copies. Reading them directly is
// the only check that also works when another extension bundles its own api
// copy. Context and propagation are left out: our own shutdown does not
// unregister them, so they would misfire on re-init.
const API_GLOBAL_KEY = Symbol.for("opentelemetry.js.api.1");
const LOGS_GLOBAL_KEY = Symbol.for("io.opentelemetry.js.api.logs");

export type ForeignSignal = "trace" | "metrics" | "logs";

/** Signals for which another OTel SDK already registered a global provider. */
export function foreignOtelProviders(): ForeignSignal[] {
  const g = globalThis as Record<symbol, unknown>;
  const api = g[API_GLOBAL_KEY] as Record<string, unknown> | undefined;
  const found: ForeignSignal[] = [];
  if (api?.trace) found.push("trace");
  if (api?.metrics) found.push("metrics");
  // api-logs stores a bare getter function, not a keyed object.
  if (g[LOGS_GLOBAL_KEY] !== undefined) found.push("logs");
  return found;
}

export function probeTcp(
  host: string,
  port: number,
  timeoutMs = 300,
): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

// Used at session_start to avoid wiring exporters at a dead endpoint —
// otherwise the metric reader / log processor begin retrying immediately and
// those failures get buffered and flushed once the endpoint comes online.
export function probeEndpoint(
  endpoint: string,
  timeoutMs = 300,
): Promise<boolean> {
  const target = parseProbeTarget(endpoint);
  if (!target) return Promise.resolve(false);
  return probeTcp(target.host, target.port, timeoutMs);
}

/** null on an unparseable endpoint. */
export function parseProbeTarget(
  endpoint: string,
): { host: string; port: number } | null {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return null;
  }
  // Scheme-less inputs like "localhost:4318" parse with protocol "localhost:"
  // and an empty hostname — reject those instead of probing 127.0.0.1:80.
  if (!u.hostname || !/^https?:$/.test(u.protocol)) return null;
  // SaaS OTLP backends are served on the scheme default port (Node strips it,
  // so `u.port` is ""), so fall back to 80/443 rather than refusing to probe.
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80,
  };
}

export type Signal = "traces" | "metrics" | "logs";

/**
 * HTTP OTLP is per-signal: the configured endpoint is a BASE url and each
 * signal appends its own resource path. gRPC uses the base endpoint as-is.
 * A base that already carries a signal path is tolerated (older configs).
 */
export function resolveSignalUrl(endpoint: string, signal: Signal): string {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    // Unparseable base: preserve the legacy string behavior rather than throw
    // during exporter construction.
    const base = endpoint
      .replace(/\/+$/, "")
      .replace(/\/v1\/(?:traces|metrics|logs)$/, "");
    return `${base}/v1/${signal}`;
  }
  const basePath = u.pathname
    .replace(/\/+$/, "")
    .replace(/\/v1\/(?:traces|metrics|logs)$/, "");
  u.pathname = `${basePath}/v1/${signal}`;
  u.hash = "";
  return u.toString();
}

type ExporterCtor<T> = new (opts: {
  url: string;
  headers: Record<string, string>;
}) => T;

/**
 * The three per-protocol exporter classes for one signal are structurally
 * distinct (each declares its own private `_url`), so they are inferred
 * independently and the result is their union rather than a single `T`.
 */
function pickByProtocol<Grpc, Proto, Http>(
  cfg: OtelConfig,
  signal: Signal,
  ctors: {
    grpc: ExporterCtor<Grpc>;
    proto: ExporterCtor<Proto>;
    http: ExporterCtor<Http>;
  },
): Grpc | Proto | Http {
  if (cfg.protocol === "grpc")
    return new ctors.grpc({ url: cfg.endpoint, headers: cfg.headers });
  const opts = {
    url: resolveSignalUrl(cfg.endpoint, signal),
    headers: cfg.headers,
  };
  if (cfg.protocol === "http/protobuf") return new ctors.proto(opts);
  return new ctors.http(opts);
}

export function initSdk(
  cfg: OtelConfig,
  notify?: Notify,
  opts: { silentSuccess?: boolean } = {},
): OtelRuntime | null {
  if (!cfg.enabled || !Object.values(cfg.signals).some(Boolean)) return null;
  if (initOnce) return sdk;

  // Providers are intentionally scoped to this extension. A foreign global
  // provider is informational rather than a reason to discard Pi telemetry.
  const foreign = foreignOtelProviders();
  if (foreign.length > 0 && !foreignNoticeSent) {
    foreignNoticeSent = true;
    notify?.(
      `pi-otel: coexisting with global OpenTelemetry providers (${foreign.join(", ")}) using isolated Pi providers.`,
      "info",
    );
  }

  configureExportHealth({
    endpoint: cfg.endpoint,
    protocol: cfg.protocol,
    signals: cfg.signals,
  });

  const baseAttributes = {
    ...cfg.resourceAttributes,
    [ATTR_SERVICE_NAME]: cfg.serviceName,
    [ATTR_PI_CWD]: cfg.cwd,
  };
  // NodeSDK previously supplied default/env/process/host detection. Preserve
  // those attributes while replacing only its global-provider registration.
  const detectedResource = defaultResource().merge(
    detectResources({ detectors: [envDetector, processDetector, hostDetector] }),
  );
  const metricResource = detectedResource.merge(
    resourceFromAttributes(baseAttributes),
  );
  // Per-process identity is useful on traces/logs but creates one permanent
  // metric series per Pi process after backend resource-attribute promotion.
  const processResource = metricResource.merge(
    resourceFromAttributes({
      [ATTR_SERVICE_INSTANCE_ID]: `${process.pid}-${randomBytes(4).toString("hex")}`,
    }),
  );

  // With traces disabled no span processor exists, so recording spans would
  // only retain attributes that can never be exported. AlwaysOff is used
  // directly rather than as a ParentBased root: a sampled propagated parent
  // would otherwise turn recording back on.
  const sampler = !cfg.signals.traces
    ? new AlwaysOffSampler()
    : cfg.sampleRatio < 1.0
      ? new ParentBasedSampler({
          root: new TraceIdRatioBasedSampler(cfg.sampleRatio),
        })
      : undefined;

  try {
    const traceProcessors = cfg.signals.traces
      ? [
          new BatchSpanProcessor(
            instrumentExporter(
              "traces",
              pickByProtocol(cfg, "traces", {
                grpc: GrpcExporter,
                proto: ProtoExporter,
                http: HttpExporter,
              }),
            ),
          ),
        ]
      : [];
    const tracerProvider = new BasicTracerProvider({
      resource: processResource,
      spanProcessors: traceProcessors,
      ...(sampler ? { sampler } : {}),
    });

    const metricProvider = cfg.signals.metrics
      ? new MeterProvider({
          resource: metricResource,
          readers: [
            new PeriodicExportingMetricReader({
              exporter: instrumentExporter(
                "metrics",
                pickByProtocol(cfg, "metrics", {
                  grpc: MetricGrpcExporter,
                  proto: MetricProtoExporter,
                  http: MetricHttpExporter,
                }),
              ),
              exportIntervalMillis: 10_000,
            }),
          ],
        })
      : null;

    const loggerProvider = cfg.signals.logs
      ? new LoggerProvider({
          resource: processResource,
          processors: [
            new BatchLogRecordProcessor({
              exporter: instrumentExporter(
                "logs",
                pickByProtocol(cfg, "logs", {
                  grpc: LogGrpcExporter,
                  proto: LogProtoExporter,
                  http: LogHttpExporter,
                }),
              ),
            }),
          ],
        })
      : null;

    configureMeterProvider(metricProvider);
    configureLoggerProvider(loggerProvider);

    // Context is separate from signal providers. Own a context manager only
    // when another SDK has not already registered one; otherwise use theirs.
    const contextManager = new AsyncLocalStorageContextManager().enable();
    if (otelContext.setGlobalContextManager(contextManager)) {
      ownedContextManager = contextManager;
    } else {
      contextManager.disable();
    }

    sdk = {
      tracer: tracerProvider.getTracer("pi-otel", "0.1.0"),
      forceFlush: async () => {
        await Promise.all([
          tracerProvider.forceFlush(),
          metricProvider?.forceFlush() ?? Promise.resolve(),
          loggerProvider?.forceFlush() ?? Promise.resolve(),
        ]);
      },
      shutdown: async () => {
        await Promise.all([
          tracerProvider.shutdown(),
          metricProvider?.shutdown() ?? Promise.resolve(),
          loggerProvider?.shutdown() ?? Promise.resolve(),
        ]);
      },
    };
    initOnce = true;
  } catch (err) {
    const e = err as Error;
    notify?.(`pi-otel: SDK start failed — ${e.message}`, "error");
    sdk = null;
    initOnce = false;
    resetExportHealth();
    resetMetricHandles();
    resetLogHandles();
    return null;
  }

  // `diag` is global. Never replace a foreign SDK's diagnostic logger; export
  // callbacks still populate Pi's delivery health in coexistence mode.
  if (cfg.signals.logs && foreign.length === 0) {
    diag.setLogger(buildBridgeDiagLogger(), {
      logLevel: cfg.logLevel,
      suppressOverrideMessage: true,
    });
    ownsDiagLogger = true;
  }

  if (!opts.silentSuccess) {
    notify?.(
      `pi-otel: OTLP wired to ${cfg.endpoint} (${cfg.protocol})`,
      "info",
    );
  }
  return sdk;
}

export async function shutdownSdk(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // swallow — silent-drop policy (SPEC §7)
  } finally {
    sdk = null;
    initOnce = false;
    if (ownsDiagLogger) {
      diag.disable();
      ownsDiagLogger = false;
    }
    if (ownedContextManager) {
      otelContext.disable();
      ownedContextManager.disable();
      ownedContextManager = null;
    }
    resetMetricHandles();
    resetLogHandles();
  }
}
