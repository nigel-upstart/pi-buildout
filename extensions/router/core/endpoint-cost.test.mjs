import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { calculateCost } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  blendedEndpointCost,
  calculateEndpointEffectiveCost,
  classifyCacheWriteRate,
  compareEndpointEffectiveCost,
} from "./endpoint-cost.ts";

function requiredModel(provider, modelId) {
  const found = getModel(provider, modelId);
  assert.ok(found, `pinned registry is missing ${provider}/${modelId}`);
  return found;
}

function pricedEndpoint(provider, modelId, input, output) {
  return { provider, modelId, costPerMillion: { input, output } };
}

function usage(overrides = {}) {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

describe("endpoint effective cost", () => {
  it("uses the output-weighted blend at the neutral provider weight", () => {
    const endpoint = pricedEndpoint("openai", "gpt-5.6-sol", 5, 30);
    assert.equal(blendedEndpointCost(endpoint), 23.75);
    assert.equal(calculateEndpointEffectiveCost(endpoint, 1.0), 23.75);
  });

  it("keeps regional registry markup in the endpoint-specific effective cost", () => {
    const global = requiredModel("amazon-bedrock", "global.anthropic.claude-sonnet-5");
    const eu = requiredModel("amazon-bedrock", "eu.anthropic.claude-sonnet-5");
    const price = (model) => ({ provider: model.provider, costPerMillion: model.cost });
    assert.equal(calculateEndpointEffectiveCost(price(global), 1.0), 8);
    assert.equal(calculateEndpointEffectiveCost(price(eu), 1.0), 8.8);
  });

  it("does not interpret Copilot's nominal token prices as billed cost", () => {
    const copilot = requiredModel("github-copilot", "gpt-5.6-sol");
    assert.equal(
      calculateEndpointEffectiveCost({ provider: copilot.provider, costPerMillion: copilot.cost }, 1.0),
      undefined,
    );
  });

  it("orders token-billed endpoints by cost, specificity, and code-point identity, then flat-rate endpoints", () => {
    const endpoints = [
      { provider: "github-copilot", modelId: "gpt-5.6-sol" },
      { provider: "z", modelId: "global.openai.gpt-5.6-sol", endpointEffectiveCost: 8 },
      { provider: "b", modelId: "openai.gpt-5.6-sol", endpointEffectiveCost: 8 },
      { provider: "a", modelId: "openai.gpt-5.6-sol", endpointEffectiveCost: 8 },
      { provider: "c", modelId: "openai.gpt-5.6-sol", endpointEffectiveCost: 7 },
      { provider: "𐀀", modelId: "same", endpointEffectiveCost: 9 },
      { provider: "", modelId: "same", endpointEffectiveCost: 9 },
    ];
    const expected = [
      "c/openai.gpt-5.6-sol",
      "a/openai.gpt-5.6-sol",
      "b/openai.gpt-5.6-sol",
      "z/global.openai.gpt-5.6-sol",
      "/same",
      "𐀀/same",
      "github-copilot/gpt-5.6-sol",
    ];
    const identities = (values) =>
      [...values].sort(compareEndpointEffectiveCost).map((endpoint) => `${endpoint.provider}/${endpoint.modelId}`);
    assert.deepEqual(identities(endpoints), expected);
    assert.deepEqual(identities([...endpoints].reverse()), expected);
    assert.deepEqual(identities([...endpoints.slice(3), ...endpoints.slice(0, 3)]), expected);

    for (const left of endpoints) {
      for (const right of endpoints) {
        const forward = Math.sign(compareEndpointEffectiveCost(left, right));
        const reverse = Math.sign(compareEndpointEffectiveCost(right, left));
        if (forward === 0) assert.equal(reverse, 0);
        else assert.equal(forward, -reverse);
      }
    }
    const ordered = [...endpoints].sort(compareEndpointEffectiveCost);
    for (let first = 0; first < ordered.length; first++) {
      for (let later = first; later < ordered.length; later++) {
        assert.ok(compareEndpointEffectiveCost(ordered[first], ordered[later]) <= 0);
      }
    }
  });
});

describe("cache-write classification", () => {
  it("classifies every valid zero and positive rate shape explicitly", () => {
    assert.equal(classifyCacheWriteRate({ cacheRead: 0.1, cacheWrite: 1.25 }), "priced_write");
    assert.equal(classifyCacheWriteRate({ cacheRead: 0.1, cacheWrite: 0 }), "no_write_line_item");
    assert.equal(classifyCacheWriteRate({ cacheRead: 0, cacheWrite: 0 }), "caching_unpriced");
    assert.equal(classifyCacheWriteRate({ cacheRead: 0, cacheWrite: 1.25 }), "priced_write");
  });

  it("rejects malformed rates instead of silently assigning a class", () => {
    for (const rates of [
      { cacheRead: -1, cacheWrite: 0 },
      { cacheRead: 0, cacheWrite: -1 },
      { cacheRead: Number.NaN, cacheWrite: 0 },
      { cacheRead: 0, cacheWrite: Number.POSITIVE_INFINITY },
    ]) {
      assert.throws(() => classifyCacheWriteRate(rates), /finite and nonnegative/);
    }
  });

  it("pins cross-provider GPT cache-write generations and known Sol exceptions", () => {
    const billedProviders = ["openai", "openai-codex", "azure-openai-responses", "amazon-bedrock", "opencode"];
    const modelId = (provider, generation) => (provider === "amazon-bedrock" ? `openai.${generation}` : generation);

    for (const generation of ["gpt-5.4", "gpt-5.5"]) {
      for (const provider of billedProviders) {
        const model = requiredModel(provider, modelId(provider, generation));
        assert.equal(model.cost.cacheWrite, 0, `${provider}/${model.id}`);
        assert.equal(classifyCacheWriteRate(model.cost), "no_write_line_item", `${provider}/${model.id}`);
      }
    }

    for (const provider of billedProviders) {
      const model = requiredModel(provider, modelId(provider, "gpt-5.6-sol"));
      assert.equal(classifyCacheWriteRate(model.cost), "priced_write", `${provider}/${model.id}`);
      assert.equal(model.cost.cacheWrite / model.cost.input, 1.25, `${provider}/${model.id}`);
    }

    for (const provider of ["github-copilot", "cloudflare-ai-gateway"]) {
      const model = requiredModel(provider, "gpt-5.6-sol");
      assert.equal(classifyCacheWriteRate(model.cost), "no_write_line_item", `${provider}/${model.id}`);
    }
  });

  it("pins the 0.80.7 registry boundary and does not invent an Opus 5 observation", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../../node_modules/@earendil-works/pi-ai/package.json", import.meta.url), "utf8"),
    );
    assert.equal(packageJson.version, "0.80.7");
    assert.equal(getModel("anthropic", "claude-opus-5"), undefined);
  });
});

describe("installed pi cost semantics", () => {
  it("charges zero for a zero short-write rate without falling back to input", () => {
    const model = requiredModel("openai", "gpt-4o");
    assert.equal(classifyCacheWriteRate(model.cost), "no_write_line_item");
    const result = calculateCost(model, usage({ cacheWrite: 100_000, totalTokens: 100_000 }));
    assert.equal(result.cacheWrite, 0);
    assert.equal(result.total, 0);
  });

  it("charges one-hour cache writes at two times the input rate", () => {
    const model = requiredModel("openai", "gpt-4o");
    const result = calculateCost(model, usage({ cacheWrite: 100_000, cacheWrite1h: 100_000, totalTokens: 100_000 }));
    assert.equal(result.cacheWrite, (model.cost.input * 2 * 100_000) / 1_000_000);
    assert.equal(result.cacheWrite, 0.5);
  });
});
