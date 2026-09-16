import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configureExportHealth,
  describeSignalHealth,
  getExportHealth,
  instrumentExporter,
  resetExportHealth,
} from "../dist/otel/health.js";

function fakeExporter(results) {
  return {
    export(_items, callback) {
      callback(results.shift());
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
}

test("export health records failed and accepted collector responses", async () => {
  resetExportHealth();
  configureExportHealth({
    endpoint: "https://collector.example",
    protocol: "http/protobuf",
    signals: { traces: true, metrics: false, logs: false },
  });
  const exporter = instrumentExporter(
    "traces",
    fakeExporter([
      { code: 1, error: new Error("collector rejected payload") },
      { code: 0 },
    ]),
  );

  await new Promise((resolve) => exporter.export([], resolve));
  let health = getExportHealth();
  assert.equal(health.signals.traces.attempts, 1);
  assert.equal(health.signals.traces.failures, 1);
  assert.match(health.signals.traces.lastError, /collector rejected/);
  assert.match(describeSignalHealth(health.signals.traces), /^failed /);

  await new Promise((resolve) => exporter.export([], resolve));
  health = getExportHealth();
  assert.equal(health.signals.traces.attempts, 2);
  assert.equal(health.signals.traces.successes, 1);
  assert.equal(health.signals.traces.lastError, undefined);
  assert.match(describeSignalHealth(health.signals.traces), /^accepted /);
  assert.equal(describeSignalHealth(health.signals.metrics), "disabled");
});

test("a synchronous exporter failure is converted into a failed result", async () => {
  resetExportHealth();
  configureExportHealth({
    endpoint: "https://collector.example",
    protocol: "http/protobuf",
    signals: { traces: true, metrics: false, logs: false },
  });
  const exporter = instrumentExporter("traces", {
    export() {
      throw new Error("boom");
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  });

  const result = await new Promise((resolve) => exporter.export([], resolve));
  assert.equal(result.code, 1);
  assert.match(result.error.message, /boom/);
  assert.equal(getExportHealth().signals.traces.failures, 1);
});
