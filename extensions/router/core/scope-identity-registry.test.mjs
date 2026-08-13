import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { canonicalModelId } from "./scope.ts";

// The registry is not exposed through the package export map, so it is loaded by path, matching
// scripts/survey-endpoint-prices.mjs.
const registryPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "node_modules",
  "@earendil-works",
  "pi-ai",
  "dist",
  "models.generated.js",
);
const { MODELS } = await import(pathToFileURL(registryPath).href);

/**
 * Registry-wide invariants for canonical model identity.
 *
 * The unit tests in scope.test.mjs pin chosen inputs to chosen outputs. They cannot see a registry
 * that grows a new entry which collides with an existing logical model, and canonicalModelId is the
 * join key for evidence priors, prompt profiles and endpoint grouping, so a collision mis-routes a
 * candidate silently instead of failing. These tests enumerate the pinned registry so that a package
 * bump which introduces such an entry fails the build.
 *
 * They are deliberately coupled to the pinned `@earendil-works/pi-ai` revision. That coupling is the
 * point: the assertion is about the registry's shape, not about a hand-chosen list.
 */

/** Region and version decoration that is intended to collapse onto one logical model. */
function allEntries() {
  return Object.entries(MODELS).flatMap(([provider, models]) =>
    Object.entries(models).map(([modelId, model]) => ({ provider, modelId, name: model.name ?? "" })),
  );
}

describe("canonical identity across the pinned registry", () => {
  it("never lets a known lossy canonicalization collide with a different model", () => {
    // canonicalModelId cannot distinguish a Bedrock version tag from a model name that ends in one,
    // because Bedrock uses bare (`-v1`) and colon-qualified (`-v1:0`) tags interchangeably. Three IDs
    // lose information as a result. None is harmful while every entry producing the reduced ID is
    // still the same model, and that is what this test enforces rather than assumes.
    //
    // The discriminator is the registry's own display name: it retains the token the ID lost. A
    // genuine non-V2 Nemotron sibling, or a DeepSeek entry that really is plain V3, would carry a
    // name without that token and fail here. Resolving the `-vN` rule would then be required rather
    // than optional.
    const lossy = [
      { canonical: "nemotron-nano-12b", nameMustContain: /v2/i },
      { canonical: "nemotron-nano-9b", nameMustContain: /v2/i },
      { canonical: "deepseek-v3", nameMustContain: /v3\.1/i },
    ];
    for (const { canonical, nameMustContain } of lossy) {
      const sources = allEntries().filter(({ modelId }) => canonicalModelId(modelId) === canonical);
      assert.ok(sources.length > 0, `${canonical} is no longer produced by any registry entry; drop this row`);
      for (const { provider, modelId, name } of sources) {
        assert.match(
          name,
          nameMustContain,
          `${provider}/${modelId} canonicalizes to ${canonical} but its name "${name}" does not carry the token the ID dropped, so canonicalModelId is now conflating two different models`,
        );
      }
    }
  });

  it("folds catalog case without merging anything that differs by more than case", () => {
    // Establishes that the case fold in canonicalModelId is safe rather than merely convenient.
    for (const [provider, models] of Object.entries(MODELS)) {
      const byLowercase = new Map();
      for (const modelId of Object.keys(models)) {
        const lowered = modelId.toLowerCase();
        const previous = byLowercase.get(lowered);
        assert.equal(
          previous,
          undefined,
          `${provider} distinguishes ${String(previous)} from ${modelId} by case alone, so folding case loses an identity`,
        );
        byLowercase.set(lowered, modelId);
      }
    }
  });

  it("resolves every scoped Bedrock endpoint to a vendor-free logical model ID", () => {
    // The scoped families are reachable only on amazon-bedrock. Each must reduce to an ID that no
    // longer carries its vendor path segment, except DeepSeek, whose catalog names omit the brand.
    // Anchored at a segment boundary rather than at the start, so region-prefixed profiles such as
    // `us.deepseek.r1-v1:0` are covered too.
    const scoped = Object.keys(MODELS["amazon-bedrock"]).filter((modelId) =>
      /(?:^|\.)(?:minimax|moonshot|moonshotai|nvidia|xai|zai|qwen)\./.test(modelId),
    );
    assert.ok(scoped.length > 0, "the pinned registry no longer exposes scoped Bedrock endpoints");
    for (const modelId of scoped) {
      const canonical = canonicalModelId(modelId);
      assert.doesNotMatch(
        canonical,
        /^(?:minimax|moonshot|moonshotai|nvidia|xai|zai|qwen)\./,
        `${modelId} still carries its vendor path segment after canonicalization`,
      );
      assert.notEqual(canonical, "", `${modelId} canonicalized to an empty ID`);
    }
    const deepseek = Object.keys(MODELS["amazon-bedrock"]).filter((modelId) => /(?:^|\.)deepseek\./.test(modelId));
    assert.ok(deepseek.length > 0, "the pinned registry no longer exposes DeepSeek Bedrock endpoints");
    for (const modelId of deepseek) {
      assert.match(
        canonicalModelId(modelId),
        /^deepseek-/,
        `${modelId} must retain its vendor segment, because DeepSeek catalog names carry no brand token`,
      );
    }
  });
});
