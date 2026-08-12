import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { providerWeightFor } from "./core/provider-weights.ts";
import {
  aggregateAttemptTokenCounts,
  aggregateRouteSamples,
  endpointTelemetryFields,
  JsonlTelemetryStore,
  percentile,
  withRouterSpan,
} from "./telemetry.ts";

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

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
  it("parses a checked-in pre-PR7 record without optional endpoint fields", async () => {
    const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "telemetry-v1-pre-pr7.jsonl");
    const events = await new JsonlTelemetryStore(fixture).read();

    assert.equal(events.length, 1);
    assert.equal(events[0].eventId, "pre-pr7-outcome");
    assert.equal(events[0].endpointEffectiveCost, undefined);
    assert.equal(events[0].appliedProviderWeight, undefined);
    assert.equal(events[0].providerWeightBasis, undefined);
    assert.equal(events[0].cacheWriteClassification, undefined);
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
