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
const logs = [];

function fakePi() {
  return {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: () => {},
    events: {
      on: () => {},
      emit: (channel, payload) => {
        if (channel === "pi-otel:log") logs.push(payload);
      },
    },
  };
}

const ctx = {
  cwd: () => cwd,
  ui: { notify: () => {} },
  sessionManager: { getSessionFile: () => "/tmp/sessions/sess-lifecycle.jsonl" },
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
      received.push(Buffer.concat(chunks));
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
        signals: { traces: true, metrics: false, logs: false },
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

  const payload = Buffer.concat(received).toString("utf8");
  assert.ok(received.length > 0, "the collector received no export");
  assert.ok(
    payload.includes("error.type"),
    "a failed request must carry error.type on its span",
  );
  assert.ok(
    payload.includes("provider exploded"),
    "the span status message must carry the provider error",
  );
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
