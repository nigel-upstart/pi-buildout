/**
 * Export delivery health shared by the scoped SDK runtime and `/otel status`.
 *
 * A successful callback means the configured OTLP endpoint accepted the
 * payload. It deliberately does not claim that a downstream backend indexed
 * the data; that remains a collector/backend health concern.
 */

export type ExportSignal = "traces" | "metrics" | "logs";

export interface SignalExportHealth {
  enabled: boolean;
  attempts: number;
  successes: number;
  failures: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastError?: string;
}

export interface ExportHealthSnapshot {
  configured: boolean;
  endpoint?: string;
  protocol?: string;
  signals: Record<ExportSignal, SignalExportHealth>;
}

type ExportResult = { code: number; error?: Error };
type ExportCallback = (result: ExportResult) => void;
type ExporterShape = {
  export(items: unknown, callback: ExportCallback): void;
  shutdown(): Promise<void>;
  forceFlush?: () => Promise<void>;
};

function emptySignal(enabled = false): SignalExportHealth {
  return { enabled, attempts: 0, successes: 0, failures: 0 };
}

let health: ExportHealthSnapshot = {
  configured: false,
  signals: {
    traces: emptySignal(),
    metrics: emptySignal(),
    logs: emptySignal(),
  },
};

export function configureExportHealth(args: {
  endpoint: string;
  protocol: string;
  signals: Record<ExportSignal, boolean>;
}): void {
  health = {
    configured: true,
    endpoint: args.endpoint,
    protocol: args.protocol,
    signals: {
      traces: emptySignal(args.signals.traces),
      metrics: emptySignal(args.signals.metrics),
      logs: emptySignal(args.signals.logs),
    },
  };
}

export function resetExportHealth(): void {
  health = {
    configured: false,
    signals: {
      traces: emptySignal(),
      metrics: emptySignal(),
      logs: emptySignal(),
    },
  };
}

export function getExportHealth(): ExportHealthSnapshot {
  return structuredClone(health);
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

function beginAttempt(signal: ExportSignal): void {
  const state = health.signals[signal];
  state.attempts += 1;
  state.lastAttemptAt = new Date().toISOString();
}

function finishAttempt(signal: ExportSignal, result: ExportResult): void {
  const state = health.signals[signal];
  const now = new Date().toISOString();
  // ExportResultCode.SUCCESS is 0 in @opentelemetry/core. Avoiding a runtime
  // import keeps the health wrapper independent of exporter implementation.
  if (result.code === 0) {
    state.successes += 1;
    state.lastSuccessAt = now;
    delete state.lastError;
    return;
  }
  state.failures += 1;
  state.lastFailureAt = now;
  state.lastError = result.error ? errorMessage(result.error) : "export failed";
}

/** Wrap an exporter without changing its protocol-specific optional methods. */
export function instrumentExporter<T extends ExporterShape>(
  signal: ExportSignal,
  exporter: T,
): T {
  return new Proxy(exporter, {
    get(target, property, receiver) {
      if (property === "export") {
        return (items: unknown, callback: ExportCallback): void => {
          beginAttempt(signal);
          try {
            target.export(items, (result) => {
              finishAttempt(signal, result);
              callback(result);
            });
          } catch (error) {
            const result = { code: 1, error: error as Error };
            finishAttempt(signal, result);
            callback(result);
          }
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function describeSignalHealth(state: SignalExportHealth): string {
  if (!state.enabled) return "disabled";
  if (state.lastSuccessAt) {
    const suffix = state.lastFailureAt && state.lastFailureAt > state.lastSuccessAt
      ? `; latest failure ${state.lastFailureAt}${state.lastError ? ` (${state.lastError})` : ""}`
      : "";
    return `accepted ${state.lastSuccessAt}${suffix}`;
  }
  if (state.lastFailureAt) {
    return `failed ${state.lastFailureAt}${state.lastError ? ` (${state.lastError})` : ""}`;
  }
  return "no export attempted yet";
}
