import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { calculateCost } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  blendedEndpointCost,
  breakEvenTokenMultiplier,
  calculateEndpointEffectiveCost,
  classifyCacheWriteRate,
  compareEndpointEffectiveCost,
  referenceMixEndpointCost,
} from "./endpoint-cost.ts";
import { providerWeightFor, resolveProviderWeights } from "./provider-weights.ts";

function requiredModel(provider, modelId) {
  const found = getModel(provider, modelId);
  assert.ok(found, `pinned registry is missing ${provider}/${modelId}`);
  return found;
}

function pricedEndpoint(provider, modelId, input, output) {
  return { provider, modelId, costPerMillion: { input, output } };
}

const builtInWeights = resolveProviderWeights().weights;

function effectiveCost(model) {
  return calculateEndpointEffectiveCost(
    { provider: model.provider, costPerMillion: model.cost },
    providerWeightFor(model.provider, builtInWeights).weight,
  );
}

function assertClose(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${String(actual)} != ${String(expected)}`);
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

  it("pins weighted effective costs from the installed registry, including regional markup", () => {
    const cases = [
      [requiredModel("amazon-bedrock", "openai.gpt-5.6-sol"), 21.68375],
      [requiredModel("openai-codex", "gpt-5.6-sol"), 23.75],
      [requiredModel("openai", "gpt-5.6-sol"), 23.77375],
      [requiredModel("amazon-bedrock", "global.anthropic.claude-sonnet-5"), 6.64],
      [requiredModel("amazon-bedrock", "eu.anthropic.claude-sonnet-5"), 7.304],
      [requiredModel("anthropic", "claude-sonnet-5"), 8],
      [requiredModel("amazon-bedrock", "au.anthropic.claude-opus-4-6-v1"), 54.78],
    ];
    for (const [model, expected] of cases) assertClose(effectiveCost(model), expected);
  });

  it("applies the unknown-provider default", () => {
    const endpoint = pricedEndpoint("new-token-provider", "gpt-5.6-sol", 5, 30);
    assertClose(
      calculateEndpointEffectiveCost(endpoint, providerWeightFor(endpoint.provider, builtInWeights).weight),
      23.9875,
    );
  });

  it("does not interpret Copilot's configured nominal weight or token prices as billed cost", () => {
    const copilot = requiredModel("github-copilot", "gpt-5.6-sol");
    const configured = resolveProviderWeights({
      projectSettings: { routerProviderWeights: { "github-copilot": 0.5 } },
    });
    assert.equal(
      calculateEndpointEffectiveCost(
        { provider: copilot.provider, costPerMillion: copilot.cost },
        providerWeightFor(copilot.provider, configured.weights).weight,
      ),
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

    for (const provider of [...billedProviders, "github-copilot"]) {
      const model = requiredModel(provider, modelId(provider, "gpt-5.6-sol"));
      assert.equal(classifyCacheWriteRate(model.cost), "priced_write", `${provider}/${model.id}`);
      const writeMultiplier = model.cost.cacheWrite / model.cost.input;
      assert.ok(Math.abs(writeMultiplier - 1.25) <= 0.001, `${provider}/${model.id}`);
    }

    const cloudflare = requiredModel("cloudflare-ai-gateway", "gpt-5.6-sol");
    assert.equal(
      classifyCacheWriteRate(cloudflare.cost),
      "no_write_line_item",
      `${cloudflare.provider}/${cloudflare.id}`,
    );
  });

  it("pins the 0.84.1 registry boundary and its Opus 5 observation", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../../../node_modules/@earendil-works/pi-ai/package.json", import.meta.url), "utf8"),
    );
    assert.equal(packageJson.version, "0.84.1");
    assert.ok(getModel("anthropic", "claude-opus-5"));
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

describe("reference-mix effective cost", () => {
  // Rates read from @earendil-works/pi-ai@0.84.1, amazon-bedrock, with the contract weight applied.
  // These are the figures recorded in specs/routing-layer/scoped-model-analysis-2026-08-13.md, so a
  // registry bump that moves a rate fails here rather than silently invalidating that record.
  const BEDROCK = {
    "minimax.minimax-m2.5": { input: 0.3, output: 1.2, cacheRead: 0, cacheWrite: 0, expected: 0.357 },
    "moonshotai.kimi-k2.5": { input: 0.6, output: 3, cacheRead: 0, cacheWrite: 0, expected: 0.785 },
    "moonshot.kimi-k2-thinking": { input: 0.6, output: 2.5, cacheRead: 0, cacheWrite: 0, expected: 0.725 },
    "deepseek.v3.2": { input: 0.62, output: 1.85, cacheRead: 0, cacheWrite: 0, expected: 0.662 },
    "zai.glm-5": { input: 1, output: 3.2, cacheRead: 0, cacheWrite: 0, expected: 1.093 },
    "openai.gpt-oss-120b": { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0, expected: 0.178 },
    "openai.gpt-5.6-luna": { input: 0.22, output: 1.32, cacheRead: 0.022, cacheWrite: 0.275, expected: 0.298 },
    "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, expected: 1.233 },
    "openai.gpt-5.6-terra": { input: 2.2, output: 13.2, cacheRead: 0.22, cacheWrite: 2.75, expected: 2.977 },
    "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, expected: 6.167 },
    "openai.gpt-5.6-sol": { input: 5.5, output: 33, cacheRead: 0.55, cacheWrite: 6.88, expected: 7.442 },
  };
  const BEDROCK_WEIGHT = 0.83;

  function rates(modelId) {
    const { input, output, cacheRead, cacheWrite } = BEDROCK[modelId];
    return { provider: "amazon-bedrock", costPerMillion: { input, output, cacheRead, cacheWrite } };
  }

  it("reproduces the recorded weighted figures for every audited endpoint", () => {
    for (const [modelId, row] of Object.entries(BEDROCK)) {
      const actual = referenceMixEndpointCost(rates(modelId)) * BEDROCK_WEIGHT;
      assert.ok(
        Math.abs(actual - row.expected) < 0.0006,
        `${modelId} priced ${actual.toFixed(4)}, recorded ${String(row.expected)}`,
      );
    }
  });

  it("charges an unpriced cache at the input rate rather than treating zero as free", () => {
    // The whole point. A zero cache rate means caching is unpriced or unsupported, so cache-read
    // tokens are billed as ordinary input. Reading zero as a discount would rank an endpoint that
    // cannot cache ahead of one that can.
    const unpriced = rates("minimax.minimax-m2.5");
    assert.equal(classifyCacheWriteRate(unpriced.costPerMillion), "caching_unpriced");
    // Its price is therefore flat in the cache-read share.
    for (const share of [0, 0.3, 0.7, 1]) {
      assert.equal(referenceMixEndpointCost(unpriced, share), referenceMixEndpointCost(unpriced, 0));
    }
    // A cache-priced endpoint gets cheaper as reuse rises.
    const priced = rates("openai.gpt-5.6-luna");
    assert.ok(referenceMixEndpointCost(priced, 0.7) < referenceMixEndpointCost(priced, 0.124));
  });

  it("shows the scoped cost advantage eroding as cache reuse rises", () => {
    // Recorded in the analysis: against Bedrock Haiku 4.5 the break-even for MiniMax M2.5 falls from
    // 3.5x to 2.4x between a 12% and a 70% cache-read share, and GLM-5 crosses below 1.0, meaning it
    // becomes more expensive per token than the rung it was supposed to undercut.
    const haiku = { rates: rates("claude-haiku-4-5"), weight: BEDROCK_WEIGHT };
    const minimax = { rates: rates("minimax.minimax-m2.5"), weight: BEDROCK_WEIGHT };
    const glm5 = { rates: rates("zai.glm-5"), weight: BEDROCK_WEIGHT };

    assert.ok(Math.abs(breakEvenTokenMultiplier(haiku, minimax, 0.124) - 3.5) < 0.05);
    assert.ok(Math.abs(breakEvenTokenMultiplier(haiku, minimax, 0.7) - 2.4) < 0.05);
    assert.ok(breakEvenTokenMultiplier(haiku, glm5, 0.124) > 1);
    assert.ok(
      breakEvenTokenMultiplier(haiku, glm5, 0.7) < 1,
      "GLM-5 must be shown as more expensive than Haiku once cache reuse is high",
    );
  });

  it("does not disturb the fixed blend or the endpoint comparator", () => {
    // The reference mix is diagnostic. Endpoint ordering within one logical model still uses the fixed
    // 25/75 blend, so adding this function must not change any route.
    const sol = rates("openai.gpt-5.6-sol");
    assert.equal(blendedEndpointCost(sol), 0.25 * 5.5 + 0.75 * 33);
    assert.notEqual(blendedEndpointCost(sol), referenceMixEndpointCost(sol));
  });

  it("rejects a nonsensical cache-read share instead of extrapolating", () => {
    assert.throws(() => referenceMixEndpointCost(rates("claude-opus-5"), 1.5), RangeError);
    assert.throws(() => referenceMixEndpointCost(rates("claude-opus-5"), -0.1), RangeError);
  });
});
