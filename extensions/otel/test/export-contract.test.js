/**
 * End-to-end export contract for the migrated OpenTelemetry SDK train.
 *
 * The other suites use a recording tracer, so they never exercise the real SDK,
 * exporter, or serializer. This one starts an in-process OTLP/HTTP receiver,
 * wires the actual NodeSDK at it, and asserts what lands on the wire — which is
 * the only way to prove that a raised attribute cap survives serialization and
 * that the 2.x SDK migration still exports.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { trace } from "@opentelemetry/api";
import { initSdk, shutdownSdk } from "../dist/otel/sdk.js";
import { applyUsageAttrs } from "../dist/attrs.js";
import { SpanTracker } from "../dist/spans.js";

const received = [];
let server;
let endpoint;

function collectorRequest(req, res) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    received.push({ url: req.url, body: Buffer.concat(chunks) });
    res.writeHead(200, { "content-type": "application/x-protobuf" });
    res.end();
  });
}

before(async () => {
  server = createServer(collectorRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await shutdownSdk();
  await new Promise((resolve) => server.close(resolve));
});

test("a >60 KiB tool result reaches the collector intact under a raised cap", async () => {
  const maxAttributeBytes = 1024 * 1024;
  const result = `${"R".repeat(200 * 1024)}TAIL`;

  const sdk = initSdk({
    enabled: true,
    endpoint,
    protocol: "http/protobuf",
    headers: {},
    serviceName: "pi-otel-export-test",
    captureContent: "full",
    maxAttributeBytes,
    spanNaming: "genai",
    sampleRatio: 1.0,
    propagateToShell: false,
    signals: { traces: true, metrics: false, logs: false },
    resourceAttributes: {},
    logLevel: 0,
    cwd: "/tmp/wd",
  });
  assert.ok(sdk, "the migrated SDK must start");

  const tracker = new SpanTracker({
    tracer: trace.getTracer("pi-otel-export-test"),
    captureContent: "full",
    maxAttributeBytes,
    spanNaming: "genai",
    cwd: "/tmp/wd",
    sessionId: () => "sess-export",
  });

  tracker.startInteraction("export contract");
  tracker.startTurn(0);
  tracker.startLlmRequest("claude-sonnet-4", "anthropic");
  tracker.startTool("call-1", "bash", { cmd: "cat big" });
  tracker.endTool("call-1", { isError: false, result });
  tracker.noteAssistantMessage({
    provider: "anthropic",
    content: "done",
  });
  // Mirrors the message_end handler in index.ts: usage attributes are lifted
  // with applyUsageAttrs and pushed onto the open LLM span.
  const usageAttrs = {};
  applyUsageAttrs(usageAttrs, {
    input: 10,
    output: 20,
    cacheRead: 5,
    reasoning: 7,
  });
  tracker.setLlmAttrs(usageAttrs);
  tracker.endLlmRequest();
  tracker.endTurn();
  tracker.endInteraction();

  await shutdownSdk(); // flushes the batch span processor

  assert.ok(received.length > 0, "the collector received no export");
  const payload = Buffer.concat(received.map((r) => r.body));
  assert.ok(
    received.every((r) => r.url === "/v1/traces"),
    `unexpected signal paths: ${received.map((r) => r.url).join(", ")}`,
  );
  const text = payload.toString("utf8");

  // Payload assertions rather than protobuf decoding: the exported attribute
  // value is a length-delimited UTF-8 string, so an intact value appears
  // verbatim and a truncated one carries the marker instead of its tail.
  assert.ok(
    text.includes("gen_ai.tool.call.result"),
    "tool result attribute missing from the export",
  );
  assert.ok(
    text.includes(result),
    "the >60 KiB tool result was not exported intact",
  );
  assert.ok(
    !text.includes("…[truncated]"),
    "content was truncated despite a raised cap",
  );
  assert.ok(
    text.includes("execute_tool bash") && text.includes("chat claude-sonnet-4"),
    "GenAI span names missing from the export",
  );
  assert.ok(
    text.includes("gen_ai.usage.cache_read.input_tokens") &&
      !text.includes("gen_ai.usage.cache_read_input_tokens"),
    "the registry token key must be exported, and only it",
  );
});
