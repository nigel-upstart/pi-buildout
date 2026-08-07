import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { aggregateRouteSamples, JsonlTelemetryStore, percentile, withRouterSpan } from "./telemetry.ts";
import type { AttemptOutcome, RouterTelemetryEvent } from "./telemetry.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function event(id: string): RouterTelemetryEvent {
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
});

describe("telemetry aggregates", () => {
  it("computes nearest-rank percentiles and comparable route samples", () => {
    assert.equal(percentile([1, 2, 3, 100], 0.75), 3);
    const outcomes: AttemptOutcome[] = Array.from({ length: 30 }, (_, index) => ({
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
    const firstOutcome = outcomes[0];
    assert.ok(firstOutcome);
    outcomes.push({ ...firstOutcome, contextBucket: "long_repository" });
    const samples = aggregateRouteSamples(outcomes);
    assert.equal(samples.length, 2);
    const sample = samples.find((candidate) => candidate.contextBucket === "multi_file_repository");
    assert.ok(sample);
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
    const globals = globalThis as Record<symbol, unknown>;
    const calls: ("end" | { name: string; options: unknown; context: unknown })[] = [];
    const span = {
      setAttribute: () => span,
      addEvent: () => span,
      recordException: () => {},
      setStatus: () => span,
      end: () => calls.push("end"),
    };
    globals[runtimeSymbol] = new Map([
      [
        "session",
        {
          tracer: {
            startSpan: (name: string, options: unknown, context: unknown) => {
              calls.push({ name, options, context });
              return span;
            },
          },
        },
      ],
    ]);
    globals[activeSymbol] = new Map([["session", { traceId: "a".repeat(32), spanId: "b".repeat(16) }]]);
    globals[apiSymbol] = {
      context: {
        active: () => ({ setValue: (key: symbol, value: unknown) => ({ key, value }) }),
      },
    };
    try {
      const result = await withRouterSpan("session", "router.route", { mode: "shadow" }, async (activeSpan) => {
        assert.equal(activeSpan, span);
        return 42;
      });
      assert.equal(result, 42);
      const firstCall = calls[0];
      assert.ok(firstCall);
      if (firstCall === "end") assert.fail("expected a span-start call before end");
      assert.equal(firstCall.name, "router.route");
      assert.ok(firstCall.context);
      assert.equal(calls.at(-1), "end");
    } finally {
      Reflect.deleteProperty(globals, runtimeSymbol);
      Reflect.deleteProperty(globals, activeSymbol);
      Reflect.deleteProperty(globals, apiSymbol);
    }
  });

  it("no-ops cleanly when the companion telemetry extension is absent", async () => {
    assert.equal(await withRouterSpan("missing", "router.route", {}, (span) => span ?? "no span"), "no span");
  });
});
