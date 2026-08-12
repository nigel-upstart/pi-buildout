import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PROVIDER_WEIGHT_MAX,
  PROVIDER_WEIGHT_MIN,
  providerWeightFor,
  resolveProviderWeights,
} from "./provider-weights.ts";

function settings(routerProviderWeights) {
  return { routerProviderWeights };
}

describe("provider route weights", () => {
  it("pins built-ins and the conservative unknown-provider default", () => {
    const { weights, rejections } = resolveProviderWeights();
    assert.deepEqual(providerWeightFor("amazon-bedrock", weights), {
      weight: 0.83,
      basis: "contract",
      source: "built-in",
    });
    for (const provider of ["openai-codex", "anthropic", "google", "google-vertex", "bifrost"]) {
      assert.deepEqual(providerWeightFor(provider, weights), {
        weight: 1,
        basis: "preference",
        source: "built-in",
      });
    }
    assert.deepEqual(providerWeightFor("openai", weights), {
      weight: 1.001,
      basis: "preference",
      source: "built-in",
    });
    assert.deepEqual(providerWeightFor("new-provider", weights), {
      weight: 1.01,
      basis: "preference",
      source: "built-in",
    });
    assert.deepEqual(rejections, []);
  });

  it("resolves precedence independently per provider and accepts both explicit entry forms", () => {
    const result = resolveProviderWeights({
      environmentValue: JSON.stringify({ "amazon-bedrock": 0.9 }),
      projectSettings: settings({ openai: { weight: 1.2, basis: "contract" } }),
      userSettings: settings({ "amazon-bedrock": 0.7, openai: 1.1, anthropic: 0.95 }),
    });
    assert.deepEqual(providerWeightFor("amazon-bedrock", result.weights), {
      weight: 0.9,
      basis: "preference",
      source: "environment",
    });
    assert.deepEqual(providerWeightFor("openai", result.weights), {
      weight: 1.2,
      basis: "contract",
      source: "project",
    });
    assert.deepEqual(providerWeightFor("anthropic", result.weights), {
      weight: 0.95,
      basis: "preference",
      source: "user",
    });
    assert.deepEqual(result.rejections, []);
  });

  it("treats empty higher-precedence maps as partial overlays", () => {
    const result = resolveProviderWeights({
      environmentValue: "{}",
      projectSettings: settings({}),
      userSettings: settings({ "amazon-bedrock": 0.75, "custom-provider": 1.2 }),
    });
    assert.equal(providerWeightFor("amazon-bedrock", result.weights).weight, 0.75);
    assert.equal(providerWeightFor("amazon-bedrock", result.weights).source, "user");
    assert.equal(providerWeightFor("custom-provider", result.weights).weight, 1.2);
  });

  it("uses a neutral rejection fallback instead of inheriting a lower-precedence discount", () => {
    const invalidValues = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0,
      -1,
      PROVIDER_WEIGHT_MIN - 0.01,
      PROVIDER_WEIGHT_MAX + 0.01,
    ];
    for (const invalid of invalidValues) {
      const result = resolveProviderWeights({
        projectSettings: settings({ "amazon-bedrock": invalid }),
        userSettings: settings({ "amazon-bedrock": 0.5 }),
      });
      assert.deepEqual(providerWeightFor("amazon-bedrock", result.weights), {
        weight: 1,
        basis: "preference",
        source: "rejection-fallback",
      });
      assert.equal(result.rejections.length, 1);
      assert.equal(result.rejections[0].provider, "amazon-bedrock");
      assert.equal(result.rejections[0].source, "project");
      assert.equal(Object.is(result.rejections[0].rejectedValue, invalid), true);
    }
  });

  it("accepts the inclusive band endpoints and rejects malformed entry objects", () => {
    const result = resolveProviderWeights({
      projectSettings: settings({
        minimum: PROVIDER_WEIGHT_MIN,
        maximum: { weight: PROVIDER_WEIGHT_MAX, basis: "contract" },
        missingBasis: { weight: 1 },
        badBasis: { weight: 1, basis: "discount" },
      }),
    });
    assert.equal(providerWeightFor("minimum", result.weights).weight, PROVIDER_WEIGHT_MIN);
    assert.equal(providerWeightFor("maximum", result.weights).weight, PROVIDER_WEIGHT_MAX);
    assert.equal(providerWeightFor("maximum", result.weights).basis, "contract");
    assert.equal(providerWeightFor("missingBasis", result.weights).source, "rejection-fallback");
    assert.equal(providerWeightFor("badBasis", result.weights).source, "rejection-fallback");
    assert.equal(result.rejections.length, 2);
  });

  it("records malformed environment JSON and falls through to project and user entries", () => {
    const malformed = resolveProviderWeights({
      environmentValue: "amazon-bedrock=0.5",
      projectSettings: settings({ "amazon-bedrock": 0.8 }),
      userSettings: settings({ anthropic: 0.9 }),
    });
    assert.equal(providerWeightFor("amazon-bedrock", malformed.weights).source, "project");
    assert.equal(providerWeightFor("anthropic", malformed.weights).source, "user");
    assert.equal(malformed.rejections.length, 1);
    assert.equal(malformed.rejections[0].provider, undefined);
    assert.equal(malformed.rejections[0].source, "environment");
    assert.match(malformed.rejections[0].reason, /valid JSON/);

    const wrongShape = resolveProviderWeights({
      environmentValue: "[]",
      userSettings: settings({ anthropic: 0.9 }),
    });
    assert.equal(providerWeightFor("anthropic", wrongShape.weights).source, "user");
    assert.match(wrongShape.rejections[0].reason, /JSON object/);
  });

  it("reads hostile and nested keys only through own data-property descriptors", () => {
    const hostile = JSON.parse('{"__proto__":0.75,"constructor":{"weight":1.2,"basis":"contract"}}');
    Object.setPrototypeOf(hostile, { inherited: 0.5 });
    let getterInvoked = false;
    Object.defineProperty(hostile, "accessor", {
      enumerable: true,
      get() {
        getterInvoked = true;
        return 0.5;
      },
    });
    const inheritedEntry = Object.create({ weight: 0.5, basis: "contract" });
    Object.defineProperty(hostile, "inheritedEntry", { enumerable: true, value: inheritedEntry });

    const result = resolveProviderWeights({ projectSettings: settings(hostile) });
    assert.equal(providerWeightFor("__proto__", result.weights).weight, 0.75);
    assert.deepEqual(providerWeightFor("constructor", result.weights), {
      weight: 1.2,
      basis: "contract",
      source: "project",
    });
    assert.equal(result.weights.has("inherited"), false);
    assert.equal(providerWeightFor("accessor", result.weights).source, "rejection-fallback");
    assert.equal(providerWeightFor("inheritedEntry", result.weights).source, "rejection-fallback");
    assert.equal(getterInvoked, false);
    assert.equal(Object.prototype.polluted, undefined);

    const inheritedSettings = Object.create({ routerProviderWeights: { anthropic: 0.5 } });
    const ignored = resolveProviderWeights({ projectSettings: inheritedSettings });
    assert.equal(providerWeightFor("anthropic", ignored.weights).weight, 1);
    assert.equal(providerWeightFor("anthropic", ignored.weights).source, "built-in");
  });
});
