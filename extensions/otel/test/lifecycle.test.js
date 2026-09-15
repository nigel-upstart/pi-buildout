/**
 * Extension-level lifecycle wiring, driven through the pi event handlers rather
 * than through SpanTracker directly. The other suites construct SpanTracker
 * themselves, so nothing else covers what index.ts does with those handlers.
 *
 * A real SDK is wired at an in-process OTLP/HTTP receiver so span-level effects
 * (status, error.type) are asserted on the exported payload.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import extension from "../dist/index.js";
import { shutdownSdk } from "../dist/otel/sdk.js";

const received = [];
let server;
let cwd;

const handlers = new Map();
const channels = new Map();
const logs = [];

function fakePi() {
  const pi = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: () => {},
    events: {
      on: (channel, handler) => {
        const existing = channels.get(channel) ?? [];
        existing.push(handler);
        channels.set(channel, existing);
      },
      // Dispatches to registered handlers, as pi's bus does. Without this the
      // extension's own pi-otel:log handler never runs, so nothing emitted on
      // that channel becomes an OTel record and a duplicate emission would be
      // invisible to the exported payload.
      emit: (channel, payload) => {
        if (channel === "pi-otel:log") logs.push(payload);
        for (const handler of channels.get(channel) ?? []) handler(payload);
      },
    },
  };
  return pi;
}

let sessionFile = "/tmp/sessions/sess-lifecycle.jsonl";

const ctx = {
  cwd: () => cwd,
  ui: { notify: () => {} },
  sessionManager: { getSessionFile: () => sessionFile },
};

async function fire(event, payload) {
  const handler = handlers.get(event);
  assert.ok(handler, `no handler registered for ${event}`);
  await handler(payload, { ...ctx, cwd });
}

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
  const endpoint = `http://127.0.0.1:${server.address().port}`;

  cwd = mkdtempSync(join(tmpdir(), "pi-otel-lifecycle-"));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      otel: {
        enabled: true,
        endpoint,
        protocol: "http/protobuf",
        captureContent: "metadata_only",
        // metrics and logs are enabled so the error path's duration metric and
        // its single pi.llm_request.error record are observable on the wire,
        // not just on the pi-otel:log channel.
        signals: { traces: true, metrics: true, logs: true },
      },
    }),
  );

  extension(fakePi());
});

after(async () => {
  await shutdownSdk();
  await new Promise((resolve) => server.close(resolve));
});

test("a failed LLM request marks its span and is logged exactly once", async () => {
  await fire("session_start", {});
  assert.equal(
    logs.filter((l) => l.eventName === "pi.session.start").length,
    1,
    "the first session must record pi.session.start",
  );

  await fire("before_agent_start", { prompt: "do the thing" });
  await fire("turn_start", { turnIndex: 0 });
  await fire("before_provider_request", { payload: { model: "claude-sonnet-4" } });
  await fire("message_end", {
    message: {
      role: "assistant",
      model: "claude-sonnet-4",
      finishReason: "error",
      errorMessage: "provider exploded",
    },
  });
  await fire("tool_execution_start", {
    toolCallId: "call-1",
    toolName: "bash",
    args: { cmd: "false" },
  });
  await fire("tool_execution_end", {
    toolCallId: "call-1",
    toolName: "bash",
    isError: true,
    result: "exit 1",
  });
  await fire("turn_end", {});
  await fire("agent_end", {});

  // endLlmRequest emits pi.llm_request.error itself, so index.ts must not also
  // push one onto the pi-otel:log channel.
  assert.deepEqual(
    logs.filter((l) => l.eventName === "pi.llm_request.error"),
    [],
    "the error record must not be emitted twice",
  );

  await fire("session_shutdown", {});

  assert.ok(received.length > 0, "the collector received no export");
  const signal = (path) =>
    Buffer.concat(received.filter((r) => r.url === path).map((r) => r.body)).toString("utf8");

  // Asserted against the trace payload alone. error.type and the error message
  // also appear on the metric and the log record, so searching every signal
  // together would pass even if the span itself were left unmarked.
  const traces = signal("/v1/traces");
  assert.match(
    traces,
    /error\.type/,
    "a failed request must carry error.type on its span",
  );
  assert.match(
    traces,
    /provider exploded/,
    "the span status message must carry the provider error",
  );

  // The duration metric must carry the error label, otherwise error rates read
  // zero in metric-based dashboards.
  const metrics = signal("/v1/metrics");
  assert.match(metrics, /gen_ai\.client\.operation\.duration/, "duration metric missing");
  assert.match(metrics, /error\.type/, "the duration metric must be labelled with the error");

  // Exactly one error record: endLlmRequest emits it, and index.ts must not add
  // a second through the pi-otel:log channel.
  const logPayload = signal("/v1/logs");
  const countRecords = (name) => logPayload.split(name).length - 1;
  assert.equal(
    countRecords("pi.llm_request.error"),
    1,
    "the request error must be recorded exactly once",
  );
  // Same rule for tools: endTool emits this record, so the handler must not add
  // a second one.
  assert.equal(
    countRecords("pi.tool.error"),
    1,
    "the tool error must be recorded exactly once",
  );
});

test("an ephemeral session does not inherit the previous session id", async () => {
  // A session transition reuses this process. With no session file, the id must
  // fall back rather than label the new session as the old one.
  sessionFile = undefined;
  const before = logs.length;
  await fire("session_start", {});
  const started = logs
    .slice(before)
    .find((l) => l.eventName === "pi.session.start");
  assert.ok(started, "the ephemeral session must still record a start");
  assert.equal(
    started.attributes["pi.session.id"],
    undefined,
    "an ephemeral session must not carry the previous session id",
  );
  assert.match(started.body, /\(ephemeral\)/);
  await fire("session_shutdown", {});
  sessionFile = "/tmp/sessions/sess-lifecycle.jsonl";
});

test("a session that follows a shutdown records its own start", async () => {
  const before = logs.filter((l) => l.eventName === "pi.session.start").length;
  await fire("session_start", {});
  const after = logs.filter((l) => l.eventName === "pi.session.start").length;
  assert.equal(
    after,
    before + 1,
    "a session after /clear or /reload must record pi.session.start",
  );
  assert.ok(
    logs.some((l) => l.eventName === "pi.session.end"),
    "the prior session must still have recorded pi.session.end",
  );
});
