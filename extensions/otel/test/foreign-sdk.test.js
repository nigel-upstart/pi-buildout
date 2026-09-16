import assert from "node:assert/strict";
import { test } from "node:test";
import { DiagLogLevel, metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  foreignOtelProviders,
  initSdk,
  shutdownSdk,
} from "../dist/otel/sdk.js";

const cfg = {
  enabled: true,
  endpoint: "http://127.0.0.1:1",
  protocol: "http/protobuf",
  headers: {},
  serviceName: "pi-otel-test",
  captureContent: "metadata_only",
  spanNaming: "legacy",
  sampleRatio: 1,
  signals: { traces: true, metrics: false, logs: false },
  resourceAttributes: {},
  logLevel: DiagLogLevel.NONE,
  cwd: process.cwd(),
};

const fakeTracer = {};
const fakeMeter = {};
const fakeLogger = {};
const fakeTracerProvider = { getTracer: () => fakeTracer };
const fakeMeterProvider = { getMeter: () => fakeMeter };
const fakeLoggerProvider = { getLogger: () => fakeLogger };

function clearGlobals() {
  trace.disable();
  metrics.disable();
  logs.disable();
}

test("no foreign providers on a clean process", () => {
  clearGlobals();
  assert.deepEqual(foreignOtelProviders(), []);
});

test("detects each foreign provider kind through the api global registry", () => {
  clearGlobals();
  assert.equal(trace.setGlobalTracerProvider(fakeTracerProvider), true);
  assert.deepEqual(foreignOtelProviders(), ["trace"]);
  metrics.setGlobalMeterProvider(fakeMeterProvider);
  logs.setGlobalLoggerProvider(fakeLoggerProvider);
  assert.deepEqual(foreignOtelProviders(), ["trace", "metrics", "logs"]);
  clearGlobals();
  assert.deepEqual(foreignOtelProviders(), []);
});

test("initSdk coexists with another SDK without replacing its globals", async () => {
  clearGlobals();
  trace.setGlobalTracerProvider(fakeTracerProvider);
  const notes = [];
  const notify = (msg, severity) => notes.push({ msg, severity });

  const runtime = initSdk(cfg, notify, { silentSuccess: true });
  assert.ok(runtime, "the scoped Pi runtime must start");
  assert.equal(
    initSdk(cfg, notify, { silentSuccess: true }),
    runtime,
    "initialization remains idempotent",
  );
  assert.equal(notes.length, 1);
  assert.equal(notes[0].severity, "info");
  assert.match(notes[0].msg, /coexisting/);
  assert.match(notes[0].msg, /isolated Pi providers/);

  // The foreign provider remains global while the returned tracer belongs to
  // Pi's isolated provider.
  assert.equal(trace.getTracerProvider().getDelegate(), fakeTracerProvider);
  assert.notEqual(runtime.tracer, trace.getTracer("pi-otel"));
  await shutdownSdk();
  assert.equal(
    trace.getTracerProvider().getDelegate(),
    fakeTracerProvider,
    "Pi shutdown must not disable the foreign provider",
  );
  clearGlobals();
});

test("own scoped init, shutdown, and re-init never registers global providers", async () => {
  clearGlobals();
  const notes = [];
  const notify = (msg, severity) => notes.push({ msg, severity });

  const first = initSdk(cfg, notify, { silentSuccess: true });
  assert.ok(first, "first init starts the SDK");
  assert.deepEqual(foreignOtelProviders(), []);
  await shutdownSdk();
  assert.deepEqual(foreignOtelProviders(), []);

  const second = initSdk(cfg, notify, { silentSuccess: true });
  assert.ok(second, "re-init after own shutdown starts again");
  assert.notEqual(second, first);
  assert.equal(
    notes.filter((n) => n.severity === "warning").length,
    0,
    JSON.stringify(notes),
  );
  await shutdownSdk();
  clearGlobals();
});
