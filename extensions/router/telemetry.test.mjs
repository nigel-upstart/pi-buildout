import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { conservativeFeatures, validateTaskFeatures } from "./core/features.ts";
import { providerWeightFor } from "./core/provider-weights.ts";
import {
  aggregateAttemptTokenCounts,
  aggregateRouteSamples,
  annotateClassifierSpan,
  attemptOutcomesFromTelemetry,
  completeClassifierInvocation,
  endpointTelemetryFields,
  JsonlTelemetryStore,
  percentile,
  runClassifierInvocation,
  sanitizeClassifierAttempt,
  sanitizeClassifierFeatures,
  withRouterSpan,
} from "./telemetry.ts";

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function event(id) {
  return {
    version: 1,
    eventId: id,
    timestamp: "2026-07-17T00:00:00.000Z",
    kind: "boundary",
    sessionId: "session",
    data: { reason: "test" },
  };
}

describe("JsonlTelemetryStore", () => {
  it("rejects persisted cache counts that are not finite and nonnegative", () => {
    // These reach aggregation through the store, so a persisted NaN would poison the token totals.
    const outcome = {
      provider: "openai-codex",
      modelId: "gpt-5.6-sol",
      archetype: "median_repository_implementation",
      accepted: true,
      modelAndToolCost: 0.42,
      wallTimeMs: 1_200,
      humanIntervention: false,
      retried: false,
    };
    const event = (data) => ({
      version: 1,
      eventId: "persisted",
      timestamp: "2026-08-12T00:00:00.000Z",
      kind: "outcome",
      sessionId: "session",
      data,
    });

    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      assert.deepEqual(
        attemptOutcomesFromTelemetry([event({ ...outcome, cacheReadTokens: invalid })]),
        [],
        `cacheReadTokens ${String(invalid)} must be rejected`,
      );
      assert.deepEqual(
        attemptOutcomesFromTelemetry([event({ ...outcome, cacheWriteTokens: invalid })]),
        [],
        `cacheWriteTokens ${String(invalid)} must be rejected`,
      );
    }
    assert.equal(attemptOutcomesFromTelemetry([event({ ...outcome, cacheReadTokens: 0 })]).length, 1);
  });

  it("parses a checked-in pre-PR7 record without optional endpoint fields", async () => {
    const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "telemetry-v1-pre-pr7.jsonl");
    const events = await new JsonlTelemetryStore(fixture).read();

    assert.equal(events.length, 1);
    assert.equal(events[0].eventId, "pre-pr7-outcome");
    assert.equal(events[0].endpointEffectiveCost, undefined);
    assert.equal(events[0].appliedProviderWeight, undefined);
    assert.equal(events[0].providerWeightBasis, undefined);
    assert.equal(events[0].cacheWriteClassification, undefined);

    const outcomes = attemptOutcomesFromTelemetry(events);
    assert.deepEqual(outcomes, [
      {
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
        archetype: "median_repository_implementation",
        accepted: true,
        modelAndToolCost: 0.42,
        wallTimeMs: 1_200,
        humanIntervention: false,
        retried: false,
      },
    ]);
    assert.deepEqual(aggregateRouteSamples(outcomes), [
      {
        provider: "openai-codex",
        modelId: "gpt-5.6-sol",
        archetype: "median_repository_implementation",
        comparableSamples: 1,
        acceptedRate: 1,
        p50ModelAndToolCost: 0.42,
        p75ModelAndToolCost: 0.42,
        p90ModelAndToolCost: 0.42,
        p50WallTimeMs: 1_200,
        p75WallTimeMs: 1_200,
        p90WallTimeMs: 1_200,
        probabilityHumanIntervention: 0,
        probabilityRetry: 0,
      },
    ]);
  });

  it("appends inspectable events and tolerates a torn final line", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-router-telemetry-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "events.jsonl");
    const store = new JsonlTelemetryStore(path);
    await store.append(event("one"));
    await store.append(event("two"));
    await appendFile(path, "{torn", "utf8");
    assert.deepEqual(
      (await store.read()).map((item) => item.eventId),
      ["one", "two"],
    );
    assert.match(await readFile(path, "utf8"), /"eventId":"one"/);
  });

  it("bounds queued callers while preserving one ordered append attempt per event", async () => {
    const gates = new Map([
      ["one", deferred()],
      ["two", deferred()],
    ]);
    const attempts = [];
    const store = new JsonlTelemetryStore("/unused/events.jsonl", {
      appendTimeoutMs: 10,
      persist: async (item) => {
        attempts.push(item.eventId);
        await gates.get(item.eventId).promise;
      },
    });

    const firstTimeout = assert.rejects(store.append(event("one")), { name: "TelemetryAppendTimeoutError" });
    const secondTimeout = assert.rejects(store.append(event("two")), { name: "TelemetryAppendTimeoutError" });
    await Promise.all([firstTimeout, secondTimeout]);
    assert.deepEqual(attempts, ["one"], "a queued event must not overtake the stalled append");

    gates.get("one").resolve();
    await new Promise(setImmediate);
    assert.deepEqual(attempts, ["one", "two"]);
    gates.get("two").resolve();
    await new Promise(setImmediate);
    assert.deepEqual(attempts, ["one", "two"], "late settlement must not retry either event");
  });

  it("clears a caller deadline when persistence settles before it", async () => {
    const timers = new Map();
    const deadline = {
      set(callback) {
        const handle = {};
        timers.set(handle, callback);
        return handle;
      },
      clear(handle) {
        timers.delete(handle);
      },
    };
    const store = new JsonlTelemetryStore("/unused/events.jsonl", {
      appendTimeoutMs: 60_000,
      persist: async () => {},
      deadline,
    });

    await store.append(event("immediate"));
    assert.equal(timers.size, 0, "a successful append must not retain its deadline timer");
  });
});

describe("classifier invocation telemetry", () => {
  it("summarizes one successful invocation and its sanitized stage attempts", async () => {
    const run = await runClassifierInvocation({
      purpose: "fresh_task",
      timeoutMs: 1_000,
      invoke: async (_signal, observe) => {
        observe({ stage: "primary", try: 1, state: "started" });
        observe({
          stage: "primary",
          try: 1,
          state: "completed",
          outcome: "valid",
          provider: "openai-codex",
          modelId: "gpt-5.6-luna",
          latencyMs: 7,
        });
        return 42;
      },
    });

    assert.equal(run.status, "completed");
    const summary = completeClassifierInvocation(run.summary, "classified", false);
    assert.equal(summary.purpose, "fresh_task");
    assert.equal(summary.outcome, "success");
    assert.equal(summary.resolution, "classified");
    assert.equal(summary.timedOut, false);
    assert.equal(summary.cancelled, false);
    assert.equal(summary.attemptCount, 1);
    assert.equal(summary.completedAttemptCount, 1);
    assert.equal(summary.validAttemptCount, 1);
    assert.deepEqual(summary.stages, [
      { stage: "primary", attemptCount: 1, completedAttemptCount: 1, validAttemptCount: 1 },
    ]);
    assert.deepEqual(summary.attempts, [
      {
        stage: "primary",
        try: 1,
        outcome: "valid",
        provider: "openai-codex",
        modelId: "gpt-5.6-luna",
        latencyMs: 7,
      },
    ]);
    assert.ok(summary.wallLatencyMs >= 0);
  });

  it("returns promptly at the deadline with an explicit timeout and cancellation", async () => {
    const run = await runClassifierInvocation({
      purpose: "continuity",
      timeoutMs: 5,
      invoke: (signal, observe) =>
        new Promise((_resolve, reject) => {
          observe({ stage: "primary", try: 1, state: "started" });
          signal.addEventListener(
            "abort",
            () => {
              observe({ stage: "primary", try: 1, state: "completed", outcome: "cancelled" });
              const error = new Error("secret prompt and credential");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    });

    assert.equal(run.status, "failed");
    assert.equal(run.summary.outcome, "timeout");
    assert.equal(run.summary.resolution, "none");
    assert.equal(run.summary.timedOut, true);
    assert.equal(run.summary.cancelled, true);
    assert.equal(run.summary.errorCategory, "deadline");
    assert.equal(run.summary.attempts[0].outcome, "cancelled");
    assert.doesNotMatch(JSON.stringify(run.summary), /secret|credential|prompt/i);
  });

  it("categorizes transport timeout, cancellation, and unexpected errors without retaining errors", async () => {
    const cases = [
      { name: "TimeoutError", outcome: "timeout", timedOut: true, cancelled: false, category: "transport_timeout" },
      { name: "AbortError", outcome: "error", timedOut: false, cancelled: true, category: "cancelled" },
      { name: "Error", outcome: "error", timedOut: false, cancelled: false, category: "unexpected" },
    ];
    for (const expected of cases) {
      const run = await runClassifierInvocation({
        purpose: "fresh_task",
        timeoutMs: 1_000,
        invoke: async () => {
          const error = new Error("api-key=super-secret prompt=private");
          error.name = expected.name;
          throw error;
        },
      });
      assert.equal(run.status, "failed");
      assert.equal(run.summary.outcome, expected.outcome);
      assert.equal(run.summary.timedOut, expected.timedOut);
      assert.equal(run.summary.cancelled, expected.cancelled);
      assert.equal(run.summary.errorCategory, expected.category);
      assert.doesNotMatch(JSON.stringify(run.summary), /super-secret|api-key|private/);
    }
  });

  it("removes free-form errors, evidence, and malformed identifiers from durable payloads", () => {
    const attempt = sanitizeClassifierAttempt({
      stage: "primary",
      try: 1,
      valid: false,
      provider: "provider secret@example.com",
      modelId: "model\ncredential=secret",
      vendor: "openai",
      latencyMs: 9,
      errors: ["credential=secret", "prompt text"],
      usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.01 },
    });
    assert.equal(attempt.provider, undefined);
    assert.equal(attempt.modelId, undefined);
    assert.equal(attempt.errorCount, 2);
    assert.deepEqual(attempt.errors, [], "legacy readers retain the errors array without sensitive contents");

    const sanitizedFeatures = sanitizeClassifierFeatures(
      conservativeFeatures("verbatim private prompt with credential=secret"),
    );
    assert.deepEqual(sanitizedFeatures.evidence, ["[redacted]"]);
    assert.equal("evidenceCount" in sanitizedFeatures, false);
    assert.equal(validateTaskFeatures(sanitizedFeatures).success, true, "legacy classifierOutput remains TaskFeatures");
    assert.doesNotMatch(JSON.stringify({ attempt, sanitizedFeatures }), /private prompt|credential=secret|prompt text/);
  });

  it("enriches an optional span with bounded attributes and events only", () => {
    const attributes = [];
    const events = [];
    const span = {
      setAttribute: (name, value) => attributes.push([name, value]),
      addEvent: (name, values) => events.push([name, values]),
    };
    const summary = {
      purpose: "continuity",
      outcome: "success",
      resolution: "retained_continuity",
      wallLatencyMs: 12,
      timedOut: false,
      cancelled: false,
      failedClosed: false,
      attemptCount: 1,
      completedAttemptCount: 1,
      validAttemptCount: 1,
      stages: [{ stage: "primary", attemptCount: 1, completedAttemptCount: 1, validAttemptCount: 1 }],
      attempts: [{ stage: "primary", try: 1, outcome: "valid", provider: "openai", modelId: "gpt-5.6-luna" }],
    };
    annotateClassifierSpan(span, summary);
    assert.deepEqual(
      attributes.find(([name]) => name === "router.classifier.outcome"),
      ["router.classifier.outcome", "success"],
    );
    assert.deepEqual(
      attributes.find(([name]) => name === "router.classifier.latency_ms"),
      ["router.classifier.latency_ms", 12],
    );
    assert.equal(events.filter(([name]) => name === "router.classifier.attempt").length, 1);
    assert.equal(events.filter(([name]) => name === "router.classifier.completed").length, 1);
    assert.doesNotMatch(JSON.stringify({ attributes, events }), /prompt|synopsis|credential|error\.message/i);
  });

  it("keeps annotations best-effort when an optional span implementation throws", () => {
    assert.doesNotThrow(() =>
      annotateClassifierSpan(
        {
          setAttribute: () => {
            throw new Error("broken exporter");
          },
          addEvent: () => {
            throw new Error("broken exporter");
          },
        },
        {
          purpose: "fresh_task",
          outcome: "error",
          resolution: "none",
          wallLatencyMs: 1,
          timedOut: false,
          cancelled: false,
          attemptCount: 0,
          completedAttemptCount: 0,
          validAttemptCount: 0,
          stages: [],
          attempts: [],
          errorCategory: "unexpected",
        },
      ),
    );
  });
});

describe("endpoint telemetry fields", () => {
  it("records the weighted effective cost and cache-rate classification", () => {
    assert.deepEqual(
      endpointTelemetryFields(
        {
          provider: "amazon-bedrock",
          costPerMillion: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
        },
        providerWeightFor("amazon-bedrock"),
      ),
      {
        endpointEffectiveCost: 19.7125,
        appliedProviderWeight: 0.83,
        providerWeightBasis: "contract",
        cacheWriteClassification: "priced_write",
      },
    );
  });

  it("keeps flat-rate endpoint costs absent without dropping cache classification", () => {
    assert.deepEqual(
      endpointTelemetryFields(
        {
          provider: "github-copilot",
          costPerMillion: { input: 0, output: 0, cacheRead: 1, cacheWrite: 0 },
        },
        providerWeightFor("github-copilot"),
      ),
      { cacheWriteClassification: "no_write_line_item" },
    );
  });
});

describe("attempt token outcomes", () => {
  it("records observed cache-read and cache-write counts independently", () => {
    assert.deepEqual(
      aggregateAttemptTokenCounts([
        { input: 100, output: 20, cacheRead: 80, cacheWrite: 10 },
        { input: 50, output: 5, cacheRead: 40, cacheWrite: 0 },
      ]),
      {
        inputTokens: 150,
        outputTokens: 25,
        cacheReadTokens: 120,
        cacheWriteTokens: 10,
      },
    );
  });

  it("tolerates a missing legacy cache-write count", () => {
    assert.equal(aggregateAttemptTokenCounts([{ input: 1, output: 1, cacheRead: 1 }]).cacheWriteTokens, 0);
  });
});

describe("telemetry aggregates", () => {
  it("computes nearest-rank percentiles and comparable route samples", () => {
    assert.equal(percentile([1, 2, 3, 100], 0.75), 3);
    const outcomes = Array.from({ length: 30 }, (_, index) => ({
      provider: "openai-codex",
      modelId: "gpt-5.6-terra",
      archetype: "median_repository_implementation",
      contextBucket: "multi_file_repository",
      risk: "medium",
      interactivity: "developer_loop",
      languageBucket: "typescript",
      accepted: index < 28,
      modelAndToolCost: index + 1,
      wallTimeMs: (index + 1) * 100,
      humanIntervention: index === 29,
      retried: index >= 28,
    }));
    outcomes.push({ ...outcomes[0], contextBucket: "long_repository" });
    const samples = aggregateRouteSamples(outcomes);
    assert.equal(samples.length, 2);
    const sample = samples.find((candidate) => candidate.contextBucket === "multi_file_repository");
    assert.equal(sample.comparableSamples, 30);
    assert.equal(sample.p50ModelAndToolCost, 15);
    assert.equal(sample.p75ModelAndToolCost, 23);
    assert.equal(sample.p90ModelAndToolCost, 27);
    assert.equal(sample.p50WallTimeMs, 1_500);
    assert.equal(sample.p75WallTimeMs, 2_300);
    assert.equal(sample.p90WallTimeMs, 2_700);
    assert.equal(sample.acceptedRate, 28 / 30);
  });
});

describe("withRouterSpan", () => {
  it("uses optional Symbol registries and parents a span without a static dependency", async () => {
    const runtimeSymbol = Symbol.for("pi.telemetry-otel.runtimeRegistry.v1");
    const activeSymbol = Symbol.for("pi.telemetry-otel.activeSpanContextRegistry.v1");
    const apiSymbol = Symbol.for("opentelemetry.js.api.1");
    const calls = [];
    const span = {
      setAttribute: () => span,
      addEvent: () => span,
      recordException: () => {},
      setStatus: () => span,
      end: () => calls.push("end"),
    };
    globalThis[runtimeSymbol] = new Map([
      [
        "session",
        {
          tracer: {
            startSpan: (name, options, context) => {
              calls.push({ name, options, context });
              return span;
            },
          },
        },
      ],
    ]);
    globalThis[activeSymbol] = new Map([["session", { traceId: "a".repeat(32), spanId: "b".repeat(16) }]]);
    globalThis[apiSymbol] = {
      context: {
        active: () => ({ setValue: (key, value) => ({ key, value }) }),
      },
    };
    try {
      const result = await withRouterSpan("session", "router.route", { mode: "shadow" }, async (activeSpan) => {
        assert.equal(activeSpan, span);
        return 42;
      });
      assert.equal(result, 42);
      assert.equal(calls[0].name, "router.route");
      assert.ok(calls[0].context);
      assert.equal(calls.at(-1), "end");
    } finally {
      delete globalThis[runtimeSymbol];
      delete globalThis[activeSymbol];
      delete globalThis[apiSymbol];
    }
  });

  it("no-ops cleanly when the companion telemetry extension is absent", async () => {
    assert.equal(await withRouterSpan("missing", "router.route", {}, (span) => span ?? "no span"), "no span");
  });
});
