/**
 * Span lifecycle balance: every span SpanTracker starts must be ended exactly
 * once.
 *
 * The type guard in `logs.ts` covers duplicate *log records*, but nothing
 * expresses span pairing in the type system — `startTool` and `endTool` are
 * ordinary calls, and a missing or doubled `end()` is a runtime property. An
 * unended span is never exported (the batch processor only ships ended spans),
 * so a leak shows up as silently missing telemetry rather than an error.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { SpanTracker } from "../dist/spans.js";

/** Recording tracer that counts end() calls per span. */
function countingTracer() {
  const spans = [];
  return {
    spans,
    startSpan(name, opts) {
      const rec = { name, ends: 0, attributes: { ...(opts?.attributes ?? {}) } };
      spans.push(rec);
      return {
        setAttribute(k, v) {
          rec.attributes[k] = v;
        },
        setStatus() {},
        addEvent() {},
        end() {
          rec.ends += 1;
        },
        spanContext: () => ({
          traceId: "0".repeat(32),
          spanId: "0".repeat(16),
        }),
      };
    },
  };
}

function tracker(tracer, captureContent = "full") {
  return new SpanTracker({
    tracer,
    captureContent,
    spanNaming: "genai",
    cwd: "/tmp/wd",
    sessionId: () => "sess-balance",
  });
}

function assertBalanced(tracer, expectedCount) {
  assert.equal(tracer.spans.length, expectedCount, "unexpected span count");
  for (const span of tracer.spans) {
    assert.equal(span.ends, 1, `${span.name} ended ${span.ends} times, expected exactly 1`);
  }
}

test("a full interaction ends every span it starts, exactly once", () => {
  const tracer = countingTracer();
  const t = tracker(tracer);
  t.startInteraction("balance");
  t.startTurn(0);
  t.startLlmRequest("claude-sonnet-4", "anthropic");
  t.noteAssistantMessage({ content: "ok", provider: "anthropic" });
  t.endLlmRequest();
  t.startTool("call-1", "bash", { cmd: "ls" });
  t.endTool("call-1", { isError: false, result: "ok" });
  t.endTurn();
  t.endInteraction();
  // interaction, turn, llm_request, tool
  assertBalanced(tracer, 4);
});

test("parallel tool calls each end once, in any completion order", () => {
  const tracer = countingTracer();
  const t = tracker(tracer);
  t.startInteraction("parallel");
  t.startTurn(0);
  t.startTool("a", "bash", { cmd: "one" });
  t.startTool("b", "read", { path: "/tmp/x" });
  t.startTool("c", "bash", { cmd: "three" });
  // Out-of-order completion is the normal case for parallel tools.
  t.endTool("b", { isError: false, result: "b" });
  t.endTool("c", { isError: true, result: "c failed" });
  t.endTool("a", { isError: false, result: "a" });
  t.endTurn();
  t.endInteraction();
  assertBalanced(tracer, 5);
});

test("an interaction abandoned mid-flight still closes its open children", () => {
  // endInteraction closes stragglers defensively. Without that, a session that
  // ends during a tool call or provider request would drop those spans entirely.
  const tracer = countingTracer();
  const t = tracker(tracer);
  t.startInteraction("abandoned");
  t.startTurn(0);
  t.startLlmRequest("claude-sonnet-4", "anthropic");
  t.startTool("stuck", "bash", { cmd: "sleep 999" });
  t.endInteraction(new Error("session shut down"));
  assertBalanced(tracer, 4);
});

test("a second interaction does not reopen or re-end the first", () => {
  const tracer = countingTracer();
  const t = tracker(tracer);
  for (const label of ["first", "second"]) {
    t.startInteraction(label);
    t.startTurn(0);
    t.startLlmRequest("m", "anthropic");
    t.endLlmRequest();
    t.endTurn();
    t.endInteraction();
  }
  assertBalanced(tracer, 6);
});

test("redundant end calls do not double-end a span", () => {
  const tracer = countingTracer();
  const t = tracker(tracer);
  t.startInteraction("redundant");
  t.startTurn(0);
  t.startLlmRequest("m", "anthropic");
  t.endLlmRequest();
  t.endLlmRequest(); // no open request; must be a no-op
  t.endTool("never-started", { isError: false });
  t.endTurn();
  t.endTurn();
  t.endInteraction();
  t.endInteraction();
  assertBalanced(tracer, 3);
});
