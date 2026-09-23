/**
 * Modified from upstream pi-otel 0.3.0: loggers come from the extension-scoped
 * LoggerProvider rather than the global API provider.
 *
 * LogRecord emission helpers + OTel diag→OTLP bridge.
 *
 * Pi-otel's OWN internal events do NOT use the global `diag` — they go
 * through the `notify` callback wired from index.ts (ctx.ui.notify), because
 * failing OTLP machinery cannot reliably report its own failures through
 * itself.
 */

import type { DiagLogger } from "@opentelemetry/api";
import {
  createNoopLogger,
  type LogAttributes,
  type Logger,
  type LoggerProvider,
  SeverityNumber,
} from "@opentelemetry/api-logs";

const LOGGER_NAME = "pi-otel";
const LOGGER_VERSION = "0.1.0";
const BRIDGE_LOGGER_NAME = "@opentelemetry/diag";

/**
 * Event-bus channel that other pi packages publish structured log records to.
 * pi-otel subscribes and forwards each record to the OTel logger.
 */
export const LOG_CHANNEL = "pi-otel:log";

/**
 * Log records emitted by `SpanTracker` as part of ending a span. It is the sole
 * emitter of these: it holds the model, tool, and error context they carry, and
 * emitting them anywhere else records the same failure twice.
 *
 * These names are shared with the emission sites so the ownership list and the
 * emitted records cannot drift apart.
 */
export const TRACKER_LOG_EVENT = {
  llmRequestError: "pi.llm_request.error",
  toolError: "pi.tool.error",
} as const;

export type TrackerOwnedLogEvent =
  (typeof TRACKER_LOG_EVENT)[keyof typeof TRACKER_LOG_EVENT];

declare const emittedBySpanTracker: unique symbol;

/**
 * Marker with no runtime form. Intersecting a tracker-owned event name with this
 * makes the name unassignable, so `tsc` rejects the call instead of the record
 * being emitted a second time.
 */
type EmittedBySpanTracker = { readonly [emittedBySpanTracker]: never };

export type LogChannelPayload<T extends string> = {
  eventName: T;
  severity?: "debug" | "info" | "warn" | "error";
  body?: string;
  attributes?: Record<string, string | number | boolean>;
};

/**
 * Typed emitter for {@link LOG_CHANNEL}. It accepts any event name except the
 * ones `SpanTracker` already emits; passing one of those fails `tsc`:
 *
 * ```ts
 * emitLog({ eventName: "pi.tool.error", body: "..." });
 * //        ~~~~~~~~~ Type '"pi.tool.error"' is not assignable to
 * //                  type '"pi.tool.error" & EmittedBySpanTracker'
 * ```
 *
 * Scope worth being precise about: this is a typecheck-time constraint on *this
 * package's own sources*, enforced by `npm run typecheck` and by the
 * `otel-extension` CI job. It is not a runtime check, and it does not constrain
 * other extensions — they publish to {@link LOG_CHANNEL} over the event bus with
 * whatever strings they choose, and nothing here can or should stop them. Its
 * purpose is narrow: stop *us* from re-adding an emission that `SpanTracker`
 * already makes, which has happened twice in this extension's history.
 *
 * A `string`-typed name also passes, because the extensibility API forwards
 * names that are only known at runtime.
 */
export function createLogChannelEmitter(
  emit: (channel: string, payload: unknown) => void,
): <T extends string>(
  payload: LogChannelPayload<T> &
    (T extends TrackerOwnedLogEvent ? { eventName: EmittedBySpanTracker } : unknown),
) => void {
  return (payload) => {
    emit(LOG_CHANNEL, payload);
  };
}

let logger: Logger | null = null;
let bridgeLogger: Logger | null = null;
let loggerProvider: LoggerProvider | null = null;

export function configureLoggerProvider(provider: LoggerProvider | null): void {
  loggerProvider = provider;
  logger = null;
  bridgeLogger = null;
}

// Without a Pi-owned provider (logs disabled or SDK not initialized) records
// are dropped rather than routed to a foreign global provider, so a disabled
// signal can never leak into another SDK's pipeline.
export function getLogger(): Logger {
  if (!logger) {
    logger =
      loggerProvider?.getLogger(LOGGER_NAME, LOGGER_VERSION) ??
      createNoopLogger();
  }
  return logger;
}

function getBridgeLogger(): Logger {
  if (!bridgeLogger) {
    bridgeLogger =
      loggerProvider?.getLogger(BRIDGE_LOGGER_NAME, LOGGER_VERSION) ??
      createNoopLogger();
  }
  return bridgeLogger;
}

export function resetLogHandles(): void {
  configureLoggerProvider(null);
}

function emitLogRecord(
  log: Logger,
  severity: SeverityNumber,
  body: string,
  attributes: LogAttributes,
): void {
  try {
    log.emit({
      severityNumber: severity,
      severityText: SeverityNumber[severity],
      body,
      attributes,
    });
  } catch {
    // best-effort
  }
}

export function emitLifecycleLog(
  eventName: string,
  severity: SeverityNumber,
  body: string,
  attrs: LogAttributes = {},
): void {
  emitLogRecord(getLogger(), severity, body, {
    "event.name": eventName,
    ...attrs,
  });
}

function stringifyArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`;
  // grpc-js callErrorFromStatus() uses Object.assign(new Error(), status), copying
  // code/details/metadata as own properties. In some runtimes instanceof fails across
  // module boundaries — fall back to duck-typing so we emit the stack, not JSON.
  if (
    a &&
    typeof a === "object" &&
    typeof (a as Record<string, unknown>).stack === "string"
  ) {
    return (a as Record<string, unknown>).stack as string;
  }
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

// Drop per-export ticks from the OTLP exporter delegate — they fire every
// batch interval and drown signal in Aspire Structured Logs.
const BRIDGE_DROP = /^(?:items to be sent|OTLPExportDelegate|Export\()/i;

// Guards against re-entrant calls: logs.getLogger() itself calls diag.warn(),
// which would recurse infinitely if bridgeLogger is not yet cached.
let bridgeEmitting = false;

function emitBridge(
  severity: SeverityNumber,
  message: unknown,
  args: unknown[],
): void {
  if (bridgeEmitting) return;
  // OTel JS internals occasionally pass an Error as the first arg even though
  // DiagLogger types it as string. Normalize so body is always a human-readable
  // string (Aspire renders body as the Message column).
  const text = typeof message === "string" ? message : stringifyArg(message);
  if (BRIDGE_DROP.test(text)) return;
  const attributes: LogAttributes =
    args.length > 0 ? { "diag.args": args.map(stringifyArg) } : {};
  bridgeEmitting = true;
  try {
    emitLogRecord(getBridgeLogger(), severity, text, attributes);
  } finally {
    bridgeEmitting = false;
  }
}

export function buildBridgeDiagLogger(): DiagLogger {
  return {
    verbose: (message, ...args) =>
      emitBridge(SeverityNumber.DEBUG, message, args),
    debug: (message, ...args) =>
      emitBridge(SeverityNumber.DEBUG, message, args),
    info: (message, ...args) => emitBridge(SeverityNumber.INFO, message, args),
    warn: (message, ...args) => emitBridge(SeverityNumber.WARN, message, args),
    error: (message, ...args) =>
      emitBridge(SeverityNumber.ERROR, message, args),
  };
}
