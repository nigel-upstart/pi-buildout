import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
} from "@opentelemetry/semantic-conventions/incubating";
import {
  applyUsageAttrs,
  ATTR_CACHE_CREATION_TOKENS,
  ATTR_CACHE_CREATION_TOKENS_LEGACY,
  ATTR_CACHE_READ_TOKENS,
  ATTR_CACHE_READ_TOKENS_LEGACY,
  ATTR_CACHE_WRITE_TOKENS,
  ATTR_INPUT_TOKENS,
  ATTR_OUTPUT_TOKENS,
  ATTR_REASONING_TOKENS,
  ATTR_REASONING_TOKENS_LEGACY,
  ATTR_SYSTEM,
} from "../dist/attrs.js";

// Pins our constants to the vendored registry package rather than to a string
// literal copied from it, so a registry upgrade that renames a key fails here
// instead of silently drifting.
test("token usage keys match the GenAI semantic-conventions registry", () => {
  assert.equal(ATTR_INPUT_TOKENS, ATTR_GEN_AI_USAGE_INPUT_TOKENS);
  assert.equal(ATTR_OUTPUT_TOKENS, ATTR_GEN_AI_USAGE_OUTPUT_TOKENS);
  assert.equal(
    ATTR_CACHE_READ_TOKENS,
    ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  );
  assert.equal(
    ATTR_CACHE_CREATION_TOKENS,
    ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
  );
  assert.equal(
    ATTR_REASONING_TOKENS,
    ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  );
});

test("gen_ai.system is still a registry attribute, so it is kept as-is", () => {
  // Issue #45 asked whether this key was deprecated/removed before changing it.
  // The registry still defines it, so no migration is warranted.
  assert.equal(ATTR_SYSTEM, ATTR_GEN_AI_SYSTEM);
});

test("cache-write tokens have no registry key and keep the existing spelling", () => {
  const registryNames = new Set(
    Object.values({
      ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
      ATTR_GEN_AI_USAGE_CACHE_CREATION_INPUT_TOKENS,
    }),
  );
  assert.equal(ATTR_CACHE_WRITE_TOKENS, "gen_ai.usage.cache_write_input_tokens");
  assert.ok(!registryNames.has(ATTR_CACHE_WRITE_TOKENS));
});

test("renamed keys are written alongside their pre-1.44 spelling", () => {
  const attrs = {};
  applyUsageAttrs(attrs, {
    input: 11,
    output: 22,
    cacheRead: 33,
    cacheWrite: 44,
    cacheCreation: 55,
    reasoning: 66,
  });
  assert.deepEqual(attrs, {
    [ATTR_INPUT_TOKENS]: 11,
    [ATTR_OUTPUT_TOKENS]: 22,
    [ATTR_CACHE_READ_TOKENS]: 33,
    [ATTR_CACHE_READ_TOKENS_LEGACY]: 33,
    [ATTR_CACHE_WRITE_TOKENS]: 44,
    [ATTR_CACHE_CREATION_TOKENS]: 55,
    [ATTR_CACHE_CREATION_TOKENS_LEGACY]: 55,
    [ATTR_REASONING_TOKENS]: 66,
    [ATTR_REASONING_TOKENS_LEGACY]: 66,
  });
});

test("absent usage fields emit neither spelling", () => {
  const attrs = {};
  applyUsageAttrs(attrs, { input: 1 });
  assert.deepEqual(Object.keys(attrs), [ATTR_INPUT_TOKENS]);
});

test("non-numeric usage values are ignored for both spellings", () => {
  for (const bad of ["7", null, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
    const attrs = {};
    applyUsageAttrs(attrs, { cacheRead: bad, reasoning: bad });
    assert.deepEqual(
      attrs,
      {},
      `usage value ${JSON.stringify(bad)} must not be exported`,
    );
  }
});

test("cost is lifted from the usage cost total", () => {
  const attrs = {};
  applyUsageAttrs(attrs, { cost: { total: 0.42 } });
  assert.equal(attrs["pi.cost.usd"], 0.42);
});
