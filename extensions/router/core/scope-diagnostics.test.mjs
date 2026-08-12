import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { providerWeightFor } from "./provider-weights.ts";
import { buildScopeDiagnostics, MAX_ROUTE_SCOPE_BYTES, renderScopeDiagnostics } from "./scope-diagnostics.ts";

function model(provider, modelId, overrides = {}) {
  return {
    provider,
    modelId,
    name: modelId,
    vendor: "openai",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    available: true,
    reasoning: true,
    supportedEfforts: ["high"],
    inputTypes: ["text"],
    toolCapable: true,
    costPerMillion: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    providerWeight: providerWeightFor(provider),
    ...overrides,
  };
}

function diagnostics(overrides = {}) {
  return buildScopeDiagnostics({
    patterns: ["*/gpt-5.6-*"],
    patternSource: "project",
    registry: [],
    allRegistryEndpoints: [],
    providerWeightRejections: [],
    ...overrides,
  });
}

describe("scope diagnostics", () => {
  it("groups resolved models and reuses the endpoint cost comparator's selection order", () => {
    const registry = [
      model("openai", "gpt-5.6-sol"),
      model("github-copilot", "gpt-5.6-sol"),
      model("amazon-bedrock", "openai.gpt-5.6-sol"),
      model("openai-codex", "gpt-5.6-sol"),
    ];
    const result = diagnostics({ registry, allRegistryEndpoints: registry });

    assert.deepEqual(
      result.logicalModels.map((entry) => entry.logicalModelId),
      ["gpt-5.6-sol"],
    );
    const endpoints = result.logicalModels[0].endpoints;
    assert.deepEqual(
      endpoints.map((endpoint) => endpoint.provider),
      ["amazon-bedrock", "openai-codex", "openai", "github-copilot"],
    );
    assert.equal(endpoints[0].listCost, 23.75);
    assert.equal(endpoints[0].appliedWeight, 0.83);
    assert.equal(endpoints[0].weightBasis, "contract");
    assert.equal(endpoints[0].cacheWriteClassification, "priced_write");
    assert.ok(Math.abs(endpoints[0].effectiveCost - 19.7125) < 1e-12);
    assert.equal(endpoints.at(-1).effectiveCost, undefined, "flat-rate endpoints remain last");
  });

  it("surfaces unmatched patterns, scope and route exclusions, and bounded weight rejections", () => {
    const registry = [
      model("openai-codex", "gpt-5.6-sol", { available: false }),
      model("openai", "gpt-5.6-sol", {
        health: {
          provider: "openai",
          modelId: "gpt-5.6-sol",
          status: "client_error",
          httpStatus: 403,
          detail: "not entitled",
        },
      }),
    ];
    const result = diagnostics({
      patterns: ["openai*/gpt-5.6-*", "github-copilot/gemini-2.5-pro"],
      registry,
      allRegistryEndpoints: registry,
      providerWeightRejections: [
        {
          provider: "amazon-bedrock",
          source: "environment",
          rejectedValueType: "number",
          reason: "weight must be between 0.5 and 2 inclusive",
        },
      ],
      latestRouteExclusions: [
        {
          candidate: "amazon-bedrock/openai.gpt-5.6-sol@max",
          code: "effort_unsupported",
          detail: "max effort is unsupported",
        },
      ],
    });

    assert.deepEqual(result.unmatchedPatterns, ["github-copilot/gemini-2.5-pro"]);
    assert.deepEqual(
      result.exclusions.map(({ source, code }) => [source, code]),
      [
        ["scope", "unavailable"],
        ["scope", "endpoint_unhealthy"],
        ["latest-route", "effort_unsupported"],
      ],
    );
    const output = renderScopeDiagnostics(result);
    assert.match(output, /source=project pattern=github-copilot\/gemini-2\.5-pro/);
    assert.match(output, /code=endpoint_unhealthy detail=last observation was 403: not entitled/);
    assert.match(output, /provider=amazon-bedrock source=environment reason=weight must be between/);
  });

  it("caps rendered UTF-8 output and reports omitted complete lines", () => {
    const registry = Array.from({ length: 100 }, (_, index) =>
      model(`provider-${String(index)}`, `gpt-5.6-sol-${String(index)}`),
    );
    const result = diagnostics({ registry, allRegistryEndpoints: registry });
    const output = renderScopeDiagnostics(result, 500);

    assert.ok(Buffer.byteLength(output, "utf8") <= 500);
    assert.match(output, /\.\.\. truncated: \d+ additional lines omitted \(500-byte budget\)$/);
    assert.ok(Buffer.byteLength(renderScopeDiagnostics(result), "utf8") <= MAX_ROUTE_SCOPE_BYTES);
  });
});
