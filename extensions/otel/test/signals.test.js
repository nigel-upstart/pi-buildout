/**
 * Real-SDK coverage for the optional metrics and logs signals.
 *
 * The 2.x migration changed how the metric reader and log processor are
 * constructed, but every other SDK test disables those signals, so a broken
 * construction would pass CI and break the traces+metrics+logs deployment this
 * repository actually runs.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { trace } from "@opentelemetry/api";
import { emitLifecycleLog } from "../dist/otel/logs.js";
import { initSdk, shutdownSdk } from "../dist/otel/sdk.js";
import { SpanTracker } from "../dist/spans.js";

const received = [];
let server;
let endpoint;

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ url: req.url, body: Buffer.concat(chunks) });
      res.writeHead(200, { "content-type": "application/x-protobuf" });
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await shutdownSdk();
  await new Promise((resolve) => server.close(resolve));
});

test("all three signals are constructed and exported by the migrated SDK", async () => {
  const sdk = initSdk({
    enabled: true,
    endpoint,
    protocol: "http/protobuf",
    headers: {},
    serviceName: "pi-otel-signals-test",
    captureContent: "metadata_only",
    maxAttributeBytes: 60 * 1024,
    spanNaming: "genai",
    sampleRatio: 1.0,
    propagateToShell: false,
    signals: { traces: true, metrics: true, logs: true },
    resourceAttributes: {},
    logLevel: 0,
    cwd: "/tmp/wd",
  });
  assert.ok(sdk, "the SDK must start with metrics and logs enabled");

  const tracker = new SpanTracker({
    tracer: trace.getTracer("pi-otel-signals-test"),
    captureContent: "metadata_only",
    spanNaming: "genai",
    cwd: "/tmp/wd",
    sessionId: () => "sess-signals",
  });

  // Produces a span plus the gen_ai.client.* metric instruments.
  tracker.startInteraction("signals");
  tracker.startTurn(0);
  tracker.startLlmRequest("claude-sonnet-4", "anthropic");
  tracker.setLlmAttrs({
    "gen_ai.usage.input_tokens": 11,
    "gen_ai.usage.output_tokens": 22,
  });
  tracker.endLlmRequest();
  tracker.endTurn();
  tracker.endInteraction();

  emitLifecycleLog("pi.session.start", SeverityNumber.INFO, "signals test", {
    "gen_ai.system": "pi",
  });

  // shutdown flushes the batch span processor, the periodic metric reader, and
  // the batch log processor, so no interval has to elapse.
  await shutdownSdk();

  const paths = new Set(received.map((r) => r.url));
  for (const expected of ["/v1/traces", "/v1/metrics", "/v1/logs"]) {
    assert.ok(paths.has(expected), `nothing was exported to ${expected}`);
  }

  const bySignal = (path) =>
    Buffer.concat(received.filter((r) => r.url === path).map((r) => r.body)).toString("utf8");

  assert.match(bySignal("/v1/metrics"), /gen_ai\.client\./, "metric instruments missing");
  assert.match(bySignal("/v1/logs"), /pi\.session\.start/, "log record missing");
  assert.match(bySignal("/v1/traces"), /chat claude-sonnet-4/, "span missing");
});
