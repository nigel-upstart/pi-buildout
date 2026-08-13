import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { healthVerdict, isEndpointHealthRecord } from "./health.ts";
import { canonicalModelId, endpointSpecificity, endpointTierFor, isFlatRateProvider, matchesScope } from "./scope.ts";

describe("canonical model identity", () => {
  it("reduces every observed spelling of a model to one logical ID", () => {
    // Bedrock region profiles, vendor paths, version suffixes and date stamps, all from the real
    // registry on a configured machine.
    assert.equal(canonicalModelId("claude-opus-5"), "claude-opus-5");
    assert.equal(canonicalModelId("anthropic.claude-opus-5"), "claude-opus-5");
    assert.equal(canonicalModelId("global.anthropic.claude-opus-5"), "claude-opus-5");
    assert.equal(canonicalModelId("us.anthropic.claude-opus-4-6-v1"), "claude-opus-4-6");
    assert.equal(canonicalModelId("us.anthropic.claude-haiku-4-5-20251001-v1:0"), "claude-haiku-4-5");
    assert.equal(canonicalModelId("us.anthropic.claude-opus-4-5-20251101-v1:0"), "claude-opus-4-5");
    assert.equal(canonicalModelId("openai.gpt-oss-120b-1:0"), "gpt-oss-120b");
    assert.equal(canonicalModelId("openai.gpt-5.6-sol"), "gpt-5.6-sol");
    assert.equal(canonicalModelId("amazon.nova-lite-v1:0"), "nova-lite");
    // A gateway carries the real ID in its last path segment.
    assert.equal(canonicalModelId("bedrock/anthropic.claude-sonnet-5"), "claude-sonnet-5");
  });

  it("normalizes the dotted Claude spelling resale catalogs use", () => {
    assert.equal(canonicalModelId("claude-opus-4.7"), "claude-opus-4-7");
    assert.equal(canonicalModelId("claude-sonnet-4.6"), "claude-sonnet-4-6");
    assert.equal(canonicalModelId("claude-haiku-4.5"), "claude-haiku-4-5");
  });

  it("leaves dotted GPT and Gemini IDs alone, because their own catalogs use dots", () => {
    assert.equal(canonicalModelId("gpt-5.6-terra"), "gpt-5.6-terra");
    assert.equal(canonicalModelId("gpt-5.4-mini"), "gpt-5.4-mini");
    assert.equal(canonicalModelId("gemini-3.5-flash"), "gemini-3.5-flash");
    assert.equal(canonicalModelId("gemini-2.5-pro"), "gemini-2.5-pro");
    assert.equal(canonicalModelId("gemini-3-flash-preview"), "gemini-3-flash-preview");
  });

  it("collapses the spellings of one model to a single group", () => {
    const opus5 = [
      "claude-opus-5",
      "anthropic.claude-opus-5",
      "us.anthropic.claude-opus-5",
      "global.anthropic.claude-opus-5",
      "eu.anthropic.claude-opus-5",
    ].map(canonicalModelId);
    assert.equal(new Set(opus5).size, 1);
  });

  it("reduces scoped Bedrock vendor paths whose model name self-identifies", () => {
    // Every one of these is reachable only on amazon-bedrock, and each used to pass through with its
    // vendor segment still attached, so it matched no logical model ID at all.
    assert.equal(canonicalModelId("zai.glm-5"), "glm-5");
    assert.equal(canonicalModelId("zai.glm-4.7"), "glm-4.7");
    assert.equal(canonicalModelId("zai.glm-4.7-flash"), "glm-4.7-flash");
    assert.equal(canonicalModelId("moonshotai.kimi-k2.5"), "kimi-k2.5");
    assert.equal(canonicalModelId("moonshot.kimi-k2-thinking"), "kimi-k2-thinking");
    assert.equal(canonicalModelId("minimax.minimax-m2.5"), "minimax-m2.5");
    assert.equal(canonicalModelId("nvidia.nemotron-super-3-120b"), "nemotron-super-3-120b");
    assert.equal(canonicalModelId("xai.grok-4.3"), "grok-4.3");
    assert.equal(canonicalModelId("qwen.qwen3-coder-next"), "qwen3-coder-next");
    assert.equal(canonicalModelId("qwen.qwen3-235b-a22b-2507-v1:0"), "qwen3-235b-a22b-2507");
  });

  it("retains the DeepSeek vendor segment, whose catalog names carry no brand token", () => {
    // Dropping the segment produced a bare `v3.2`, which identifies no vendor and would collide with
    // any other catalog's `v3.2`.
    assert.equal(canonicalModelId("deepseek.v3.2"), "deepseek-v3.2");
    assert.equal(canonicalModelId("deepseek.v3-v1:0"), "deepseek-v3");
    // Dropping the segment and then the version suffix produced a bare `r1`.
    assert.equal(canonicalModelId("deepseek.r1-v1:0"), "deepseek-r1");
    assert.equal(canonicalModelId("us.deepseek.r1-v1:0"), "deepseek-r1");
    // The regional and bare DeepSeek profiles must still group together.
    assert.equal(new Set(["deepseek.r1-v1:0", "us.deepseek.r1-v1:0"].map(canonicalModelId)).size, 1);
  });

  it("does not mistake a dotted model name for a vendor path segment", () => {
    // The leading segment of each of these is `gpt-5`, `gemini-3` and `claude-opus-4`, none a vendor.
    assert.equal(canonicalModelId("gpt-5.6-terra"), "gpt-5.6-terra");
    assert.equal(canonicalModelId("gemini-3.5-flash"), "gemini-3.5-flash");
    assert.equal(canonicalModelId("claude-opus-4.7"), "claude-opus-4-7");
  });

  // Known and deliberately unfixed. VERSION_SUFFIX cannot distinguish a Bedrock version tag from a
  // model name that ends in one, because Bedrock uses both bare (`claude-opus-4-6-v1`) and
  // colon-qualified (`-v1:0`) tags. NVIDIA ships "Nemotron Nano 12B V2" and "9B V2", so the `-v2`
  // here is part of the name and is being removed as though it were a tag.
  //
  // Recorded rather than fixed for two reasons: the pinned registry contains no non-V2 sibling for
  // either model, so nothing currently collides; and no policy candidate names any Nemotron model,
  // so the ID is unreachable. Guessing a rule that splits the two meanings of `-vN` would be a local
  // invention with no source behind it. This test exists so the conflation is visible and a future
  // sibling entry breaks the build instead of silently grouping two models.
  it("records the unresolved -vN ambiguity in the Nemotron IDs", () => {
    assert.equal(canonicalModelId("nvidia.nemotron-nano-12b-v2"), "nemotron-nano-12b");
    assert.equal(canonicalModelId("nvidia.nemotron-nano-9b-v2"), "nemotron-nano-9b");
    // The unambiguous siblings are unaffected, which bounds the blast radius to the two IDs above.
    assert.equal(canonicalModelId("nvidia.nemotron-super-3-120b"), "nemotron-super-3-120b");
    assert.equal(canonicalModelId("nvidia.nemotron-nano-3-30b"), "nemotron-nano-3-30b");
  });

  it("keeps distinct scoped models in distinct logical groups", () => {
    const distinct = [
      "deepseek.v3.2",
      "deepseek.v3-v1:0",
      "deepseek.r1-v1:0",
      "moonshotai.kimi-k2.5",
      "moonshot.kimi-k2-thinking",
      "minimax.minimax-m2",
      "minimax.minimax-m2.1",
      "minimax.minimax-m2.5",
      "zai.glm-5",
      "zai.glm-4.7",
      "zai.glm-4.7-flash",
    ].map(canonicalModelId);
    assert.equal(new Set(distinct).size, distinct.length);
  });

  // Behaviour lock for every incumbent spelling the router already routes. Canonicalization decides
  // evidence-prior lookup, prompt-profile lookup and endpoint grouping, so a silent change here
  // would mis-route a candidate rather than fail. This PR must not move any of these.
  it("leaves every incumbent spelling byte-identical", () => {
    const golden = {
      "claude-opus-5": "claude-opus-5",
      "anthropic.claude-opus-5": "claude-opus-5",
      "global.anthropic.claude-opus-5": "claude-opus-5",
      "us.anthropic.claude-opus-4-6-v1": "claude-opus-4-6",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0": "claude-haiku-4-5",
      "us.anthropic.claude-opus-4-5-20251101-v1:0": "claude-opus-4-5",
      "eu.anthropic.claude-sonnet-5": "claude-sonnet-5",
      "jp.anthropic.claude-opus-4-8": "claude-opus-4-8",
      "au.anthropic.claude-sonnet-4-6": "claude-sonnet-4-6",
      "anthropic.claude-fable-5": "claude-fable-5",
      "claude-opus-4.7": "claude-opus-4-7",
      "claude-sonnet-4.6": "claude-sonnet-4-6",
      "claude-haiku-4.5": "claude-haiku-4-5",
      "openai.gpt-oss-120b-1:0": "gpt-oss-120b",
      "openai.gpt-oss-120b": "gpt-oss-120b",
      "openai.gpt-5.6-sol": "gpt-5.6-sol",
      "openai.gpt-5.6-luna": "gpt-5.6-luna",
      "openai.gpt-5.6-terra": "gpt-5.6-terra",
      "gpt-5.6-terra": "gpt-5.6-terra",
      "gpt-5.4-mini": "gpt-5.4-mini",
      "gemini-3.5-flash": "gemini-3.5-flash",
      "gemini-2.5-pro": "gemini-2.5-pro",
      "gemini-3-flash-preview": "gemini-3-flash-preview",
      "amazon.nova-lite-v1:0": "nova-lite",
      "us.meta.llama4-scout-17b-instruct-v1:0": "llama4-scout-17b-instruct",
      "mistral.devstral-2-123b": "devstral-2-123b",
      "bedrock/anthropic.claude-sonnet-5": "claude-sonnet-5",
    };
    for (const [spelling, expected] of Object.entries(golden)) {
      assert.equal(canonicalModelId(spelling), expected, `canonicalModelId(${spelling})`);
    }
  });
});

describe("endpoint metadata and tie-breaks", () => {
  it("classifies first-party routes, gateways, resale, and unknown providers for diagnostics", () => {
    assert.equal(endpointTierFor("anthropic"), "manufacturer");
    assert.equal(endpointTierFor("openai-codex"), "manufacturer");
    assert.equal(endpointTierFor("google-vertex"), "manufacturer");
    assert.equal(endpointTierFor("bifrost"), "gateway");
    assert.equal(endpointTierFor("amazon-bedrock"), "resale");
    assert.equal(endpointTierFor("github-copilot"), "resale");
    // An unclassified provider keeps the conservative diagnostic label; cost ordering is separate.
    assert.equal(endpointTierFor("some-new-broker"), "resale");
  });

  it("identifies flat-rate providers so their modeled token price is not treated as a cost", () => {
    assert.equal(isFlatRateProvider("github-copilot"), true);
    assert.equal(isFlatRateProvider("anthropic"), false);
  });

  it("prefers the plainest spelling of an ID within a provider", () => {
    const plain = endpointSpecificity("anthropic.claude-opus-5");
    const global = endpointSpecificity("global.anthropic.claude-opus-5");
    const regional = endpointSpecificity("us.anthropic.claude-opus-5");
    assert.ok(plain < global, "a bare ID is preferred over a global profile");
    assert.ok(global < regional, "a global profile is preferred over a single region");
    const versioned = endpointSpecificity("us.anthropic.claude-opus-4-6-v1");
    const dated = endpointSpecificity("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    assert.ok(plain < regional, "a bare ID is preferred over a region profile");
    assert.ok(regional < versioned, "an unversioned ID is preferred over a pinned version");
    assert.ok(versioned < dated, "a dated release is the least preferred");
  });
});

describe("model scope", () => {
  // The real scope from a configured machine, abbreviated.
  const patterns = [
    "anthropic/claude-opus-5",
    "anthropic/claude-fable-5",
    "amazon-bedrock/openai.gpt-oss-120b-1:0",
    "amazon-bedrock/us.anthropic.claude-opus-4-6-v1",
    "github-copilot/gpt-5.5",
    "openai-codex/gpt-5.6-sol",
  ];

  it("admits exactly the scoped endpoints", () => {
    assert.equal(matchesScope("anthropic", "claude-opus-5", patterns), true);
    assert.equal(matchesScope("amazon-bedrock", "openai.gpt-oss-120b-1:0", patterns), true);
    assert.equal(matchesScope("github-copilot", "gpt-5.5", patterns), true);
  });

  it("excludes an endpoint the operator did not scope in, even for a scoped model", () => {
    // claude-opus-5 is scoped on the Anthropic route only; its Bedrock profiles are not.
    assert.equal(matchesScope("amazon-bedrock", "global.anthropic.claude-opus-5", patterns), false);
    // gpt-5.5 is scoped on Copilot only here, not on the OpenAI route.
    assert.equal(matchesScope("openai-codex", "gpt-5.5", patterns), false);
    assert.equal(matchesScope("google-vertex", "gemini-3.6-flash", patterns), false);
  });

  it("treats an empty pattern list as no scope configured", () => {
    assert.equal(matchesScope("anything", "at-all", []), true);
  });

  it("supports globs and bare model IDs", () => {
    assert.equal(matchesScope("anthropic", "claude-opus-5", ["anthropic/*"]), true);
    assert.equal(matchesScope("anthropic", "claude-opus-5", ["*opus*"]), true);
    assert.equal(matchesScope("anthropic", "claude-opus-5", ["claude-opus-5"]), true);
    assert.equal(matchesScope("anthropic", "claude-sonnet-5", ["*opus*"]), false);
  });

  it("ignores a thinking-level suffix without mangling Bedrock IDs that end in a version", () => {
    assert.equal(matchesScope("openai-codex", "gpt-5.6-sol", ["openai-codex/gpt-5.6-sol:high"]), true);
    // `:0` is part of the identity, not a thinking level.
    assert.equal(
      matchesScope("amazon-bedrock", "openai.gpt-oss-120b-1:0", ["amazon-bedrock/openai.gpt-oss-120b-1:0"]),
      true,
    );
  });
});

describe("endpoint health", () => {
  it("excludes only recurring failures", () => {
    // A 4xx will recur until configuration changes, so routing to it wastes an attempt.
    const clientError = healthVerdict({
      provider: "amazon-bedrock",
      modelId: "us.meta.llama4-scout-17b-instruct-v1:0",
      status: "client_error",
      httpStatus: 400,
      detail: "Validation error",
    });
    assert.equal(clientError.usable, false);
    assert.match(clientError.reason, /400/);
    assert.equal(healthVerdict({ provider: "p", modelId: "m", status: "failed" }).usable, false);
  });

  it("keeps transient failures and unprobed endpoints usable", () => {
    // Excluding an endpoint for a provider outage would shrink the chain exactly when it is needed.
    assert.equal(healthVerdict({ provider: "p", modelId: "m", status: "server_error" }).usable, true);
    assert.equal(healthVerdict({ provider: "p", modelId: "m", status: "timeout" }).usable, true);
    assert.equal(healthVerdict({ provider: "p", modelId: "m", status: "unknown" }).usable, true);
    assert.equal(healthVerdict({ provider: "p", modelId: "m", status: "ok" }).usable, true);
    // No record at all is not evidence of failure.
    assert.equal(healthVerdict(undefined).usable, true);
  });

  it("validates a health record and rejects a malformed one rather than trusting it", () => {
    assert.equal(
      isEndpointHealthRecord({
        schemaVersion: 1,
        probedAt: "2026-07-25T00:00:00.000Z",
        endpoints: [{ provider: "anthropic", modelId: "claude-opus-5", status: "ok" }],
      }),
      true,
    );
    assert.equal(isEndpointHealthRecord({ schemaVersion: 2, probedAt: "x", endpoints: [] }), false);
    assert.equal(
      isEndpointHealthRecord({
        schemaVersion: 1,
        probedAt: "x",
        endpoints: [{ provider: "a", modelId: "b", status: "not-a-status" }],
      }),
      false,
    );
    assert.equal(isEndpointHealthRecord(undefined), false);
  });
});
